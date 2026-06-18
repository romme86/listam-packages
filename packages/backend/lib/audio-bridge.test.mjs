import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { encodeFrame, decodeBody, createFrameParser, FRAME, RESP, LED_COLOR, makeReply, startAudioBridge } from './audio-bridge.mjs'
import { createUtteranceAssembler } from './voice-bridge.mjs'

function startFrame (wakeWordId, epochMs) {
    const p = Buffer.alloc(5)
    p[0] = wakeWordId
    p.writeUInt32LE(epochMs, 1)
    return encodeFrame(FRAME.START, p)
}
const chunkFrame = (pcm) => encodeFrame(FRAME.CHUNK, pcm)
const endFrame = (reason) => encodeFrame(FRAME.END, Buffer.from([reason]))
const endFrameLabeled = (reason, fired, probMilli, featPeak) => {
    const p = Buffer.alloc(6)
    p[0] = reason
    p[1] = fired ? 1 : 0
    p.writeUInt16LE(probMilli, 2)
    p.writeUInt16LE(featPeak, 4)
    return encodeFrame(FRAME.END, p)
}

test('encode/decode round-trips each frame type', () => {
    assert.deepEqual(decodeBody(encodeFrame(FRAME.HELLO, Buffer.from('leaf-1')).slice(3)), { type: 'hello', leafId: 'leaf-1' })
    assert.deepEqual(decodeBody(startFrame(2, 123456).slice(3)), { type: 'start', wakeWordId: 2, epochMs: 123456 })
    assert.deepEqual(decodeBody(endFrame(1).slice(3)), { type: 'end', reason: 'max' })
})

test('decodes the optional on-device wake label tail on END', () => {
    assert.deepEqual(decodeBody(endFrameLabeled(0, true, 996, 626).slice(3)), {
        type: 'end', reason: 'silence', wake: { fired: true, prob: 0.996, featPeak: 626 },
    })
    // older firmware sends reason only — no wake key
    assert.deepEqual(decodeBody(endFrame(0).slice(3)), { type: 'end', reason: 'silence' })
})

test('assembler attaches the wake label to the utterance', () => {
    const out = []
    const a = createUtteranceAssembler({ onUtterance: (u) => out.push(u) })
    const p = createFrameParser()
    const feed = (frame) => { for (const f of p.push(frame)) a.onFrame(f) }
    feed(startFrame(1, 0))
    feed(chunkFrame(Buffer.from([1, 0])))
    feed(endFrameLabeled(0, true, 950, 600))
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].wake, { fired: true, prob: 0.95, featPeak: 600 })
})

test('parser yields complete frames from one buffer', () => {
    const p = createFrameParser()
    const buf = Buffer.concat([startFrame(1, 0), chunkFrame(Buffer.from([1, 2, 3, 4])), endFrame(0)])
    const frames = p.push(buf)
    assert.deepEqual(frames.map((f) => f.type), ['start', 'chunk', 'end'])
})

test('parser reassembles frames split across arbitrary byte boundaries', () => {
    const p = createFrameParser()
    const buf = Buffer.concat([startFrame(1, 7), chunkFrame(Buffer.from([9, 9])), endFrame(0)])
    const got = []
    for (const b of buf) got.push(...p.push(Buffer.from([b]))) // one byte at a time
    assert.deepEqual(got.map((f) => f.type), ['start', 'chunk', 'end'])
    assert.equal(got[0].epochMs, 7)
})

test('parser resyncs (drops buffer) on a garbage length prefix', () => {
    const p = createFrameParser()
    const bad = Buffer.from([0, 0, 0]) // bodyLen 0 -> invalid
    assert.deepEqual(p.push(bad), [])
})

test('assembler joins START..CHUNK*..END into one PCM utterance', () => {
    const out = []
    const a = createUtteranceAssembler({ onUtterance: (u) => out.push(u) })
    const p = createFrameParser()
    const feed = (frame) => { for (const f of p.push(frame)) a.onFrame(f) }
    feed(startFrame(3, 1000))
    feed(chunkFrame(Buffer.from([1, 0, 2, 0])))
    feed(chunkFrame(Buffer.from([3, 0, 4, 0])))
    feed(endFrame(0))
    assert.equal(out.length, 1)
    assert.equal(out[0].wakeWordId, 3)
    assert.equal(out[0].reason, 'silence')
    assert.deepEqual([...out[0].pcm], [1, 0, 2, 0, 3, 0, 4, 0])
    assert.equal(out[0].sampleRate, 16000)
})

test('assembler enforces the max-bytes cap', () => {
    const out = []
    const a = createUtteranceAssembler({ onUtterance: (u) => out.push(u), maxBytes: 6 })
    a.onFrame({ type: 'start', wakeWordId: 1, epochMs: 0 })
    a.onFrame({ type: 'chunk', pcm: Buffer.from([1, 2, 3, 4]) })
    a.onFrame({ type: 'chunk', pcm: Buffer.from([5, 6, 7, 8]) }) // crosses 6 bytes -> finalize 'max'
    assert.equal(out.length, 1)
    assert.equal(out[0].reason, 'max')
})

test('a new START before END supersedes the open utterance', () => {
    const out = []
    const a = createUtteranceAssembler({ onUtterance: (u) => out.push(u) })
    a.onFrame({ type: 'start', wakeWordId: 1, epochMs: 0 })
    a.onFrame({ type: 'chunk', pcm: Buffer.from([1, 1]) })
    a.onFrame({ type: 'start', wakeWordId: 2, epochMs: 1 }) // supersede
    a.onFrame({ type: 'chunk', pcm: Buffer.from([2, 2]) })
    a.onFrame({ type: 'end', reason: 'silence' })
    assert.equal(out.length, 2)
    assert.equal(out[0].reason, 'superseded')
    assert.equal(out[1].wakeWordId, 2)
})

// --- Host -> leaf LED feedback channel ---

class FakeSocket extends EventEmitter {
    constructor () { super(); this.written = [] }
    setNoDelay () {}
    write (buf) { this.written.push(Buffer.from(buf)); return true }
    destroy () { this.emit('close') }
    feed (buf) { this.emit('data', Buffer.from(buf)) }
}

function fakeTcp () {
    let connHandler = null
    const server = new EventEmitter()
    server.listen = (port, host, cb) => { if (cb) cb() }
    server.close = (cb) => { if (cb) cb() }
    return {
        createServer (h) { connHandler = h; return server },
        connect () { const s = new FakeSocket(); connHandler(s); return s },
    }
}

test('LED feedback frames encode with the documented bytes', () => {
    const led = encodeFrame(RESP.LED, Buffer.from([LED_COLOR.purple]))
    assert.equal(led.readUIntLE(0, 3), 2) // bodyLen = type + 1-byte color
    assert.equal(led[3], 0x10)            // RESP.LED
    assert.equal(led[4], 2)               // purple
    const done = encodeFrame(RESP.DONE)
    assert.equal(done.readUIntLE(0, 3), 1)
    assert.equal(done[3], 0x11)           // RESP.DONE
})

test('makeReply writes LED/DONE frames and stops after the socket closes', () => {
    const sock = new FakeSocket()
    const reply = makeReply(sock)
    reply.led('yellow')
    assert.equal(sock.written.length, 1)
    assert.deepEqual([...sock.written[0]], [2, 0, 0, RESP.LED, LED_COLOR.yellow])
    sock.emit('close')
    reply.led('green')
    reply.done()
    assert.equal(sock.written.length, 1, 'no writes after close')
})

test('startAudioBridge hands onUtterance a reply that writes back to the leaf', async () => {
    const tcp = fakeTcp()
    let gotReply = null
    let gotUtterance = null
    const bridge = await startAudioBridge({
        tcp, port: 0,
        onUtterance: (u, reply) => { gotUtterance = u; gotReply = reply },
    })
    const sock = tcp.connect()
    sock.feed(Buffer.concat([startFrame(1, 0), chunkFrame(Buffer.from([1, 0, 2, 0])), endFrame(0)]))
    assert.ok(gotUtterance, 'utterance assembled')
    assert.ok(gotReply, 'reply channel provided')

    sock.written.length = 0
    gotReply.led('green')
    gotReply.done()
    const all = Buffer.concat(sock.written)
    assert.equal(all.readUIntLE(0, 3), 2)   // LED frame body len
    assert.equal(all[3], RESP.LED)
    assert.equal(all[4], LED_COLOR.green)
    assert.equal(all.readUIntLE(5, 3), 1)   // DONE frame body len
    assert.equal(all[8], RESP.DONE)
    await bridge.close()
})
