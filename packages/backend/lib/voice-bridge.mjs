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

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2 // PCM16
// Hard cap so a noisy room / malicious leaf can't stream unbounded into memory.
const DEFAULT_MAX_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 30 // 30 s

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

    function finalize (reason) {
        if (!active) return
        const pcm = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes)
        const utterance = { pcm, sampleRate, wakeWordId, reason, bytes, durationMs: Math.round((bytes / BYTES_PER_SAMPLE / sampleRate) * 1000) }
        reset()
        log(`utterance ${utterance.bytes} bytes (~${utterance.durationMs} ms), reason=${reason}`)
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
                finalize(typeof frame.reason === 'string' ? frame.reason : 'end')
                break
            default:
                break
        }
    }

    return { onFrame, reset, get active () { return active } }
}
