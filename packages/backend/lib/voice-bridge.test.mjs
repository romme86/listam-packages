import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePcm16 } from './voice-bridge.mjs'

function pcmOf (...samples) {
    const buf = Buffer.alloc(samples.length * 2)
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2))
    return buf
}

function samplesOf (buf) {
    const out = []
    for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i))
    return out
}

test('normalizePcm16 lifts a quiet capture to the target peak', () => {
    // -30 dBFS-ish peak (1000/32768) — the measured leaf level.
    const out = normalizePcm16(pcmOf(1000, -500, 250))
    const peak = Math.max(...samplesOf(out).map(Math.abs))
    // target 0.5 * 32767 ≈ 16383; gain ≈ 16.38
    assert.ok(peak >= 16000 && peak <= 16584, `peak ${peak} near target`)
    // Relative shape preserved (linear gain).
    const [a, b, c] = samplesOf(out)
    assert.ok(Math.abs(b / a + 0.5) < 0.01)
    assert.ok(Math.abs(c / a - 0.25) < 0.01)
})

test('normalizePcm16 caps gain so near-silence is not blown up into noise', () => {
    const out = normalizePcm16(pcmOf(10, -5)) // needs 1638x, capped at 24x
    assert.deepEqual(samplesOf(out), [240, -120])
})

test('normalizePcm16 never attenuates and skips already-healthy audio', () => {
    const healthy = pcmOf(20000, -18000)
    assert.equal(normalizePcm16(healthy), healthy) // same buffer back, untouched
})

test('normalizePcm16 saturates instead of wrapping', () => {
    // Peak 8000 → gain ~2.05 hits the 0.5 target; a co-sample near full scale
    // must clamp, not overflow. Use explicit options to force clipping.
    const out = normalizePcm16(pcmOf(8000, 30000), { targetPeak: 1, maxGain: 4 })
    const [, b] = samplesOf(out)
    assert.equal(b, 32767)
})

test('normalizePcm16 tolerates empty/degenerate input', () => {
    const empty = Buffer.alloc(0)
    assert.equal(normalizePcm16(empty), empty)
    assert.equal(normalizePcm16(null), null)
    const silence = pcmOf(0, 0)
    assert.equal(normalizePcm16(silence), silence)
})
