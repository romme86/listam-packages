// whisper.cpp speech-to-text under the BARE runtime (the desktop Pear worker).
//
// Mirrors whisper-cpp-subprocess.mjs (the Node host path) but uses the injected
// Bare modules — bare-subprocess for spawn, bare-fs for the temp WAV, b4a for
// byte handling — because Bare has no Node `child_process`/`fs/promises`/
// `Buffer`. The runtime modules are INJECTED (not imported) so this stays pure
// and unit-testable, and so the desktop worker passes its bare-* instances.
//
//   createWhisperBareStt({ config:{ binPath, modelPath, extraArgs }, subprocess,
//                          fs, tmpDir, logger })
//
// Proven on-device: the Pear/Bare runtime spawns whisper-cli via bare-subprocess
// and transcribes correctly (spike 2026-06-21, "yo aggiungi latte" -> "aggiungi
// latte.").

import b4a from 'b4a'
import { buildWhisperArgs, cleanWhisperOutput } from './whisper-cpp-subprocess.mjs'

function writeAscii (buf, str, offset) {
    for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i) & 0xff
}

// PCM16 mono -> WAV bytes, byte-identical to whisper-cpp-subprocess.pcm16ToWav
// but built with b4a + DataView (no Node Buffer under Bare).
export function pcm16ToWavBytes (pcm, sampleRate = 16000) {
    const channels = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    const blockAlign = channels * (bitsPerSample / 8)
    const dataLen = pcm.length
    const header = b4a.alloc(44)
    const dv = new DataView(header.buffer, header.byteOffset, 44)
    writeAscii(header, 'RIFF', 0)
    dv.setUint32(4, 36 + dataLen, true)
    writeAscii(header, 'WAVE', 8)
    writeAscii(header, 'fmt ', 12)
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true) // PCM
    dv.setUint16(22, channels, true)
    dv.setUint32(24, sampleRate, true)
    dv.setUint32(28, byteRate, true)
    dv.setUint16(32, blockAlign, true)
    dv.setUint16(34, bitsPerSample, true)
    writeAscii(header, 'data', 36)
    dv.setUint32(40, dataLen, true)
    return b4a.concat([header, b4a.from(pcm)])
}

let wavSeq = 0

export function createWhisperBareStt ({ config = {}, subprocess = null, fs = null, tmpDir = '/tmp', logger = null } = {}) {
    const binPath = config.binPath || 'whisper-cli'
    const modelPath = config.modelPath || null
    const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : []
    const log = (m) => { try { logger?.info?.(`[stt:whisper-bare] ${m}`) } catch {} }

    async function available () {
        if (!modelPath || !subprocess || !fs) return false
        // bare-fs has no fs.access(promises); statSync throwing == missing.
        try { fs.statSync(modelPath); return true } catch { return false }
    }

    async function transcribe ({ pcm, sampleRate = 16000, locale = 'auto' }) {
        if (!modelPath) throw new Error('whisper model not configured (config.voice.modelPath)')
        if (!subprocess || !fs) throw new Error('whisper-bare needs injected subprocess + fs')
        const wavPath = `${tmpDir}/listam-voice-${Date.now()}-${++wavSeq}.wav`
        fs.writeFileSync(wavPath, pcm16ToWavBytes(pcm, sampleRate))
        try {
            // Bare has no node:os to probe core count; default to 8 (a sane cap for
            // performance cores on the desktop hosts that run voice). Overridable
            // via config.threads.
            const threads = Number(config.threads) > 0 ? Number(config.threads) : 8
            const args = buildWhisperArgs({ modelPath, wavPath, locale, threads, extraArgs })
            const text = await new Promise((resolve, reject) => {
                let out = ''
                let child
                try {
                    child = subprocess.spawn(binPath, args)
                } catch (err) { return reject(err) }
                child.stdout?.on('data', (d) => { out += typeof d === 'string' ? d : b4a.toString(d) })
                child.on('error', reject)
                child.on('exit', (code) => {
                    if (code === 0) resolve(cleanWhisperOutput(out))
                    else reject(new Error(`whisper-cli exited ${code}`))
                })
            })
            log(`transcribed ${pcm.length} bytes -> "${text.slice(0, 60)}"`)
            return { text, locale }
        } finally {
            try { fs.unlinkSync(wavPath) } catch { /* best effort */ }
        }
    }

    return { engine: 'whisper-bare', available, transcribe }
}
