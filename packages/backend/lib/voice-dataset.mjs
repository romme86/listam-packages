// Voice training-dataset writer: persists every leaf utterance the audio bridge
// receives as a WAV + JSON sidecar, auto-labeled with the on-device wake result
// (positive "yo" that fired vs hard-negative that merely tripped the dB gate).
//
// This is how we build a REAL-LIFE "yo" corpus on the always-on instance (the
// headless peer is the audio sink) to retrain / improve the wake model later —
// positives AND hard-negatives, which are exactly what cuts false-accepts.
//
// Pure-ish + testable: the filesystem is INJECTED (`fs` = a fs/promises-like
// { mkdir, writeFile, readdir, unlink }), and `now` is overridable. Only the
// headless (Node) wires this today; the WAV encoder is reused from the STT path.
import { pcm16ToWav } from './stt/whisper-cpp-subprocess.mjs'

const joinPath = (dir, name) => `${String(dir).replace(/\/+$/, '')}/${name}`

// Filesystem-safe label fragment for the wake outcome.
function wakeTag (wake) {
    if (!wake) return 'unk' // firmware too old to send the label
    return wake.fired ? 'yes' : 'no'
}

export function createUtteranceDataset ({
    dir,
    fs,
    logger = null,
    maxFiles = 5000, // ~ a few hundred MB of 1-2s clips; oldest pruned past this
    now = () => Date.now(),
} = {}) {
    if (!dir) throw new Error('createUtteranceDataset requires a dir')
    if (!fs?.writeFile || !fs?.mkdir) throw new Error('createUtteranceDataset requires an fs with mkdir/writeFile')
    const log = (m) => { try { logger?.log?.(`[voice-dataset] ${m}`) ?? logger?.info?.(`[voice-dataset] ${m}`) } catch {} }

    let ensured = null
    const ensureDir = () => (ensured ??= Promise.resolve(fs.mkdir(dir, { recursive: true })))

    // Sortable, filesystem-safe timestamp; ISO order == chronological order, so a
    // lexical sort of filenames is also an age sort (used by prune()).
    function stamp () {
        return new Date(now()).toISOString().replace(/[:]/g, '-').replace(/\.(\d+)Z$/, '-$1Z')
    }

    async function prune () {
        if (!maxFiles || maxFiles <= 0) return
        try {
            const wavs = (await fs.readdir(dir)).filter((f) => f.endsWith('.wav')).sort()
            const excess = wavs.length - maxFiles
            if (excess <= 0) return
            for (const f of wavs.slice(0, excess)) {
                await fs.unlink(joinPath(dir, f)).catch(() => {})
                await fs.unlink(joinPath(dir, f.replace(/\.wav$/, '.json'))).catch(() => {})
            }
            log(`pruned ${excess} old clip(s) past cap ${maxFiles}`)
        } catch (err) {
            log(`prune failed: ${err?.message || err}`)
        }
    }

    // Save one utterance (the object from voice-bridge.mjs finalize()). Returns the
    // WAV path, or null if there is nothing to store. Never throws — dataset
    // collection must never break the live voice pipeline.
    async function save (utterance) {
        try {
            if (!utterance?.pcm?.length) return null
            await ensureDir()
            const wake = utterance.wake ?? null
            const probMilli = wake ? Math.round((wake.prob ?? 0) * 1000) : null
            const base = `${stamp()}_fired-${wakeTag(wake)}${probMilli == null ? '' : `_p${probMilli}`}_${utterance.reason ?? 'end'}`
            const wavPath = joinPath(dir, `${base}.wav`)
            const meta = {
                ts: new Date(now()).toISOString(),
                reason: utterance.reason ?? null,
                wakeWordId: utterance.wakeWordId ?? null,
                bytes: utterance.bytes ?? utterance.pcm.length,
                durationMs: utterance.durationMs ?? null,
                sampleRate: utterance.sampleRate ?? 16000,
                wake, // { fired, prob, featPeak } or null
            }
            await fs.writeFile(wavPath, pcm16ToWav(utterance.pcm, utterance.sampleRate))
            await fs.writeFile(joinPath(dir, `${base}.json`), JSON.stringify(meta, null, 2))
            log(`saved ${base}.wav (${meta.bytes}B, wake=${wake ? (wake.fired ? `FIRED@${(wake.prob ?? 0).toFixed(3)}` : `no@${(wake.prob ?? 0).toFixed(3)}`) : 'unlabeled'})`)
            await prune()
            return wavPath
        } catch (err) {
            log(`save failed: ${err?.message || err}`)
            return null
        }
    }

    return { save, prune, dir }
}
