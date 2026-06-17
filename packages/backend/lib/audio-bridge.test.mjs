import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, decodeBody, createFrameParser, FRAME } from './audio-bridge.mjs'
import { createUtteranceAssembler } from './voice-bridge.mjs'

function startFrame (wakeWordId, epochMs) {
    const p = Buffer.alloc(5)
    p[0] = wakeWordId
    p.writeUInt32LE(epochMs, 1)
    return encodeFrame(FRAME.START, p)
}
const chunkFrame = (pcm) => encodeFrame(FRAME.CHUNK, pcm)
const endFrame = (reason) => encodeFrame(FRAME.END, Buffer.from([reason]))

test('encode/decode round-trips each frame type', () => {
    assert.deepEqual(decodeBody(encodeFrame(FRAME.HELLO, Buffer.from('leaf-1')).slice(3)), { type: 'hello', leafId: 'leaf-1' })
    assert.deepEqual(decodeBody(startFrame(2, 123456).slice(3)), { type: 'start', wakeWordId: 2, epochMs: 123456 })
    assert.deepEqual(decodeBody(endFrame(1).slice(3)), { type: 'end', reason: 'max' })
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
