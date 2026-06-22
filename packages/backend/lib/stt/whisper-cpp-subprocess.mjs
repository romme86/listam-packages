// whisper.cpp speech-to-text via a subprocess (Node host path).
//
// Chosen for v1 because it is proven, has no Bare-runtime addon constraints, and
// one multilingual GGML model covers all six UI locales. The Bare/desktop path
// uses QVAC instead (stt/qvac.mjs, later). Node-only deps (child_process/fs/os)
// are lazy-imported so a host without voice configured boots unchanged.
//
// Config: { binPath = 'whisper-cli', modelPath, extraArgs = [] }

// PCM16 mono -> WAV buffer (whisper.cpp reads a WAV/PCM file). Pure + testable.
export function pcm16ToWav (pcm, sampleRate = 16000) {
    const channels = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    const blockAlign = channels * (bitsPerSample / 8)
    const dataLen = pcm.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + dataLen, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataLen, 40)
    return Buffer.concat([header, Buffer.from(pcm)])
}

// whisper-cli args: model, input wav, language, no-timestamps, no-progress. Pure.
//
// Decode is forced greedy and single-pass for low latency: short list-commands
// ("aggiungi pane") do not need whisper-cli's default beam-5 + best-of-5 search
// or its temperature-fallback re-decodes, which dominate per-utterance time.
//   -bs 1  beam size 1 (greedy)   -bo 1  best-of 1   -nf  no temperature fallback
// Accuracy is held by the initial --prompt vocabulary bias (extraArgs) and the
// write-gate confidence floors; anything here is overridable via extraArgs, which
// is concatenated LAST so a user-supplied flag wins. `threads` is computed by the
// caller (Node reads node:os; the Bare path has none) and only appended when set,
// so this stays a pure, runtime-agnostic, Bare-safe function.
export function buildWhisperArgs ({ modelPath, wavPath, locale, threads, extraArgs = [] }) {
    const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np', '-bs', '1', '-bo', '1', '-nf']
    if (Number.isInteger(threads) && threads > 0) args.push('-t', String(threads))
    if (locale && locale !== 'auto') args.push('-l', locale)
    return args.concat(extraArgs)
}

// whisper.cpp prints the transcript (sometimes with bracketed timestamps even
// under -nt on older builds); strip leading [..] tags and collapse whitespace.
export function cleanWhisperOutput (stdout) {
    return String(stdout || '')
        .split('\n')
        .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
}

export function createWhisperCppStt ({ config = {}, logger = null } = {}) {
    const binPath = config.binPath || 'whisper-cli'
    const modelPath = config.modelPath || null
    const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : []
    const log = (m) => { try { logger?.info?.(`[stt:whisper] ${m}`) } catch {} }

    let mods = null
    async function load () {
        if (mods) return mods
        const [cp, fs, os, path] = await Promise.all([
            import('node:child_process'), import('node:fs/promises'), import('node:os'), import('node:path'),
        ])
        mods = { cp, fs, os: os.default || os, path: path.default || path }
        return mods
    }

    async function available () {
        if (!modelPath) return false
        try { const { fs } = await load(); await fs.access(modelPath); return true } catch { return false }
    }

    async function transcribe ({ pcm, sampleRate = 16000, locale = 'auto' }) {
        if (!modelPath) throw new Error('whisper model not configured (config.voice.modelPath)')
        const { cp, fs, os, path } = await load()
        const wavPath = path.join(os.tmpdir(), `listam-voice-${process.pid}-${Date.now()}.wav`)
        await fs.writeFile(wavPath, pcm16ToWav(pcm, sampleRate))
        try {
            // Cap at 8 to keep work on performance cores (more threads onto E-cores
            // can regress). Overridable via config.threads.
            const threads = Number(config.threads) > 0
                ? Number(config.threads)
                : Math.min(8, os.availableParallelism?.() || os.cpus?.().length || 4)
            const args = buildWhisperArgs({ modelPath, wavPath, locale, threads, extraArgs })
            const text = await new Promise((resolve, reject) => {
                const child = cp.execFile(binPath, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
                    if (err) return reject(err)
                    resolve(cleanWhisperOutput(stdout))
                })
                child.on('error', reject)
            })
            log(`transcribed ${pcm.length} bytes -> "${text.slice(0, 60)}"`)
            return { text, locale }
        } finally {
            try { await fs.unlink(wavPath) } catch {}
        }
    }

    return { engine: 'whisper-cpp', available, transcribe }
}
