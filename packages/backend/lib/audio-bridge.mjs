// Side-band audio bridge: receives leaf voice audio over a dedicated TCP socket,
// separate from the hypercore replication stream (which is a raw byte pipe with
// no demux hook). Owns the wire codec + a TCP listener; reassembly lives in
// voice-bridge.mjs and transcription/intent downstream.
//
// Wire frame (matches the leaf firmware, leaf-esp32/src/voice.rs):
//   [u24le bodyLen][body...]   where body[0] = type, body[1..] = payload
//   leaf -> host:
//     0x00 HELLO  payload = utf8 leaf id
//     0x01 START  payload = [u8 wakeWordId][u32le epochMs]
//     0x02 CHUNK  payload = PCM16LE, 16 kHz mono
//     0x03 END    payload = [u8 reason] (0=silence,1=max,2=aborted), optionally
//                 followed by the on-device wake label so utterances can be saved
//                 to the training dataset auto-labeled positive/hard-negative:
//                 [u8 fired][u16le probMilli (prob*1000)][u16le featPeak]
//   host -> leaf (LED feedback, read by the leaf after it sends END):
//     0x10 LED    payload = [u8 color]  (0=off,1=yellow,2=purple,3=green,4=red)
//     0x11 DONE   payload = none        (host finished; leaf resets to idle)
//
// The injected `tcp` (Node `net` or `bare-tcp`) mirrors how leaf-bridge.mjs is
// constructed, so this builds on both runtimes.

import { createUtteranceAssembler } from './voice-bridge.mjs'
import b4a from 'b4a'

// The socket chunks are Node Buffers on the headless host but plain Uint8Array
// under Bare (the desktop worker), which has NO Buffer.readUIntLE/writeUIntLE/
// .copy/Buffer.concat. b4a + manual little-endian byte math work on BOTH, so the
// same codec runs in both runtimes.
const EMPTY = b4a.alloc(0)
const readU16LE = (b, o) => b[o] | (b[o + 1] << 8)
const readU24LE = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const readU32LE = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000

export const FRAME = { HELLO: 0x00, START: 0x01, CHUNK: 0x02, END: 0x03 }
// Host -> leaf response frames. The leaf mirrors LED onto its onboard RGB once it
// has sent END, so the colors reflect host-side recognition, not the dB gate.
export const RESP = { LED: 0x10, DONE: 0x11 }
export const LED_COLOR = { off: 0, yellow: 1, purple: 2, green: 3, red: 4 }
const END_REASON = { 0: 'silence', 1: 'max', 2: 'aborted' }
const MAX_BODY = 1 << 24 // u24le ceiling; guards against a garbage length prefix

export function encodeFrame (type, payload = EMPTY) {
    const body = b4a.concat([b4a.from([type]), payload])
    const out = b4a.alloc(3 + body.length)
    out[0] = body.length & 0xff
    out[1] = (body.length >>> 8) & 0xff
    out[2] = (body.length >>> 16) & 0xff
    out.set(body, 3)
    return out
}

export function decodeBody (body) {
    const type = body[0]
    switch (type) {
        case FRAME.HELLO: return { type: 'hello', leafId: b4a.toString(body.subarray(1), 'utf8') }
        case FRAME.START: return { type: 'start', wakeWordId: body[1] ?? 0, epochMs: body.length >= 6 ? readU32LE(body, 2) : 0 }
        case FRAME.CHUNK: return { type: 'chunk', pcm: body.subarray(1) }
        case FRAME.END: {
            const end = { type: 'end', reason: END_REASON[body[1]] ?? 'end' }
            // Optional on-device wake label tail (older firmware sends reason only).
            if (body.length >= 7) {
                end.wake = {
                    fired: body[2] === 1,
                    prob: readU16LE(body, 3) / 1000,
                    featPeak: readU16LE(body, 5),
                }
            }
            return end
        }
        default: return { type: 'unknown', raw: type }
    }
}

// Streaming length-prefixed frame parser. push() returns any complete decoded
// frames; partial frames are buffered until the rest arrives.
export function createFrameParser () {
    let buf = EMPTY
    return {
        push (chunk) {
            const c = b4a.from(chunk)
            buf = buf.length ? b4a.concat([buf, c]) : c
            const frames = []
            while (buf.length >= 3) {
                const bodyLen = readU24LE(buf, 0)
                if (bodyLen <= 0 || bodyLen > MAX_BODY) { buf = EMPTY; break } // resync on garbage
                if (buf.length < 3 + bodyLen) break
                frames.push(decodeBody(buf.subarray(3, 3 + bodyLen)))
                buf = buf.subarray(3 + bodyLen)
            }
            return frames
        },
        reset () { buf = EMPTY },
    }
}

// Per-connection LED feedback channel handed to onUtterance. Writes are
// best-effort: a closed/broken socket silently drops feedback (the leaf has its
// own read timeout). `led(name)` takes an LED_COLOR key; `done()` ends the run.
export function makeReply (socket, log = () => {}) {
    let open = true
    const markClosed = () => { open = false }
    socket.on?.('close', markClosed)
    socket.on?.('error', markClosed)
    const write = (buf) => {
        if (!open) return
        try { socket.write(buf) } catch (err) { log(`reply write failed: ${err?.message || err}`) }
    }
    return {
        led: (name) => write(encodeFrame(RESP.LED, b4a.from([LED_COLOR[name] ?? 0]))),
        done: () => write(encodeFrame(RESP.DONE)),
    }
}

// Start the TCP listener. `tcp` is an injected net-like module ({ createServer }).
export async function startAudioBridge ({ tcp, port, host = '0.0.0.0', onUtterance, maxBytes, logger = null } = {}) {
    if (!tcp?.createServer) throw new Error('startAudioBridge requires an injected tcp with createServer')
    if (typeof onUtterance !== 'function') throw new Error('startAudioBridge requires onUtterance')
    const log = (m) => { try { logger?.info?.(`[audio-bridge] ${m}`) } catch {} }
    const sockets = new Set()

    const server = tcp.createServer((socket) => {
        sockets.add(socket)
        try { socket.setNoDelay?.(true) } catch {}
        const reply = makeReply(socket, log)
        const parser = createFrameParser()
        // onUtterance gets the reply channel so it can light the leaf LED at each
        // recognition milestone (wake word → command → saved).
        const assembler = createUtteranceAssembler({ onUtterance: (u) => onUtterance(u, reply), maxBytes, logger })
        socket.on('data', (chunk) => { for (const f of parser.push(chunk)) assembler.onFrame(f) })
        socket.on('error', () => {})
        socket.on('close', () => { sockets.delete(socket) })
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
    })
    log(`listening on ${host}:${port}`)

    return {
        port,
        connections: () => sockets.size,
        close: () => new Promise((resolve) => {
            for (const s of sockets) { try { s.destroy() } catch {} }
            sockets.clear()
            try { server.close(() => resolve()) } catch { resolve() }
        }),
    }
}
