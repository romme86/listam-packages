// Utterance assembler for leaf voice audio.
//
// Consumes DECODED audio frames (from audio-bridge.mjs) for a single leaf
// connection and reassembles a START → CHUNK* → END run into one PCM buffer,
// then hands it to `onUtterance` for transcription. Pure (no IO) so it unit-tests
// without sockets. One assembler per connection.
//
// Frame shapes (decoded):
//   { type: 'hello', leafId }
//   { type: 'start', wakeWordId, epochMs }
//   { type: 'chunk', pcm: Buffer }
//   { type: 'end',   reason }

import b4a from 'b4a'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2 // PCM16
// Hard cap so a noisy room / malicious leaf can't stream unbounded into memory.
const DEFAULT_MAX_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 30 // 30 s

// Peak-normalize a PCM16LE buffer toward `targetPeak` (fraction of full scale).
// The leaf's INMP441 path runs quiet (measured speech peaks near -30 dBFS, at
// the room's noise floor), which starves both whisper and any downstream model;
// this lifts each utterance to a healthy level host-side, independent of the
// firmware's own gain. Gain is capped so a near-silent (ambient-only) capture
// is not amplified into loud noise, and never attenuates (gain >= 1). Returns
// the input buffer untouched when no meaningful gain applies. Pure.
export function normalizePcm16 (pcm, { targetPeak = 0.5, maxGain = 24 } = {}) {
    if (!pcm || pcm.length < BYTES_PER_SAMPLE) return pcm
    const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
    let peak = 0
    for (let i = 0; i < samples; i++) {
        const v = Math.abs((pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16 >> 16)
        if (v > peak) peak = v
    }
    if (peak === 0) return pcm
    const gain = Math.min(maxGain, (targetPeak * 32767) / peak)
    if (gain <= 1.05) return pcm
    const out = b4a.allocUnsafe(samples * BYTES_PER_SAMPLE)
    for (let i = 0; i < samples; i++) {
        const v = (pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16 >> 16
        const scaled = Math.max(-32768, Math.min(32767, Math.round(v * gain)))
        out[2 * i] = scaled & 0xff
        out[2 * i + 1] = (scaled >> 8) & 0xff
    }
    return out
}

export function createUtteranceAssembler ({
    onUtterance,
    maxBytes = DEFAULT_MAX_BYTES,
    sampleRate = SAMPLE_RATE,
    logger = null,
} = {}) {
    if (typeof onUtterance !== 'function') throw new Error('createUtteranceAssembler requires onUtterance')
    const log = (m) => { try { logger?.info?.(`[voice-bridge] ${m}`) } catch {} }

    let active = false
    let wakeWordId = 0
    let startedAt = 0
    let chunks = []
    let bytes = 0

    function reset () { active = false; wakeWordId = 0; startedAt = 0; chunks = []; bytes = 0 }

    function finalize (reason, wake = null) {
        if (!active) return
        // b4a.concat (not Buffer.concat — absent under Bare). chunks already sum
        // to `bytes`, so no explicit length arg is needed.
        const pcm = chunks.length === 1 ? chunks[0] : b4a.concat(chunks)
        const utterance = { pcm, sampleRate, wakeWordId, reason, bytes, durationMs: Math.round((bytes / BYTES_PER_SAMPLE / sampleRate) * 1000) }
        // On-device wake label from the END frame (firmware ≥ the labeled build):
        // lets the dataset writer tag positives ("yo" fired) vs hard-negatives.
        if (wake) utterance.wake = wake
        reset()
        log(`utterance ${utterance.bytes} bytes (~${utterance.durationMs} ms), reason=${reason}${wake ? `, wake=${wake.fired ? 'FIRED' : 'no'}@${wake.prob?.toFixed?.(3)}` : ''}`)
        try { onUtterance(utterance) } catch (err) { log(`onUtterance threw: ${err?.message || err}`) }
    }

    function onFrame (frame) {
        if (!frame || typeof frame !== 'object') return
        switch (frame.type) {
            case 'hello':
                log(`hello from leaf ${frame.leafId ?? '?'}`)
                break
            case 'start':
                if (active) finalize('superseded') // a new wake before END closes the old one
                active = true
                wakeWordId = frame.wakeWordId | 0
                startedAt = frame.epochMs | 0
                chunks = []
                bytes = 0
                break
            case 'chunk':
                if (!active || !frame.pcm?.length) return
                chunks.push(frame.pcm)
                bytes += frame.pcm.length
                if (bytes >= maxBytes) finalize('max')
                break
            case 'end':
                finalize(typeof frame.reason === 'string' ? frame.reason : 'end', frame.wake ?? null)
                break
            default:
                break
        }
    }

    return { onFrame, reset, get active () { return active } }
}
