// Side-band audio bridge: receives leaf voice audio over a dedicated TCP socket,
// separate from the hypercore replication stream (which is a raw byte pipe with
// no demux hook). Owns the wire codec + a TCP listener; reassembly lives in
// voice-bridge.mjs and transcription/intent downstream.
//
// Wire frame (matches the leaf firmware, leaf-esp32/src/voice.rs):
//   [u24le bodyLen][body...]   where body[0] = type, body[1..] = payload
//     0x00 HELLO  payload = utf8 leaf id
//     0x01 START  payload = [u8 wakeWordId][u32le epochMs]
//     0x02 CHUNK  payload = PCM16LE, 16 kHz mono
//     0x03 END    payload = [u8 reason]  (0=silence, 1=max, 2=aborted)
//
// The injected `tcp` (Node `net` or `bare-tcp`) mirrors how leaf-bridge.mjs is
// constructed, so this builds on both runtimes.

import { createUtteranceAssembler } from './voice-bridge.mjs'

export const FRAME = { HELLO: 0x00, START: 0x01, CHUNK: 0x02, END: 0x03 }
const END_REASON = { 0: 'silence', 1: 'max', 2: 'aborted' }
const MAX_BODY = 1 << 24 // u24le ceiling; guards against a garbage length prefix

export function encodeFrame (type, payload = Buffer.alloc(0)) {
    const body = Buffer.concat([Buffer.from([type]), payload])
    const out = Buffer.alloc(3 + body.length)
    out.writeUIntLE(body.length, 0, 3)
    body.copy(out, 3)
    return out
}

export function decodeBody (body) {
    const type = body[0]
    switch (type) {
        case FRAME.HELLO: return { type: 'hello', leafId: body.slice(1).toString('utf8') }
        case FRAME.START: return { type: 'start', wakeWordId: body[1] ?? 0, epochMs: body.length >= 6 ? body.readUInt32LE(2) : 0 }
        case FRAME.CHUNK: return { type: 'chunk', pcm: body.slice(1) }
        case FRAME.END: return { type: 'end', reason: END_REASON[body[1]] ?? 'end' }
        default: return { type: 'unknown', raw: type }
    }
}

// Streaming length-prefixed frame parser. push() returns any complete decoded
// frames; partial frames are buffered until the rest arrives.
export function createFrameParser () {
    let buf = Buffer.alloc(0)
    return {
        push (chunk) {
            buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
            const frames = []
            while (buf.length >= 3) {
                const bodyLen = buf.readUIntLE(0, 3)
                if (bodyLen <= 0 || bodyLen > MAX_BODY) { buf = Buffer.alloc(0); break } // resync on garbage
                if (buf.length < 3 + bodyLen) break
                frames.push(decodeBody(buf.slice(3, 3 + bodyLen)))
                buf = buf.slice(3 + bodyLen)
            }
            return frames
        },
        reset () { buf = Buffer.alloc(0) },
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
        const parser = createFrameParser()
        const assembler = createUtteranceAssembler({ onUtterance, maxBytes, logger })
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
