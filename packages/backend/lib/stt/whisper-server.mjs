// whisper.cpp speech-to-text via a long-running whisper-server (Node host path).
//
// The per-utterance whisper-cli spawn (whisper-cpp-subprocess.mjs) pays a full
// model load per command — ~2.5 s with a warm page cache and tens of seconds
// cold on a shared host — before any audio is processed. whisper-server loads
// the model ONCE and answers HTTP inference requests, so per-utterance cost
// drops to encode+decode only. Measured on the Geekom VM (medium, -ac 768):
// ~12 s/utterance via whisper-cli → ~3.6 s via a warm server.
//
// Two modes:
//   managed  (default)   — this engine spawns `whisper-server` bound to
//                          127.0.0.1:<serverPort> on first use, restarts it if
//                          it dies, and kills it on stop(). If the port already
//                          answers HTTP (e.g. a server surviving a service
//                          restart), it is adopted instead of respawned.
//   external (serverUrl) — inference is POSTed to an operator-managed server;
//                          never spawned or killed here. stop() is a no-op.
//
// Node-only (child_process/fs plus global fetch/FormData/Blob); the desktop
// Bare worker keeps using the 'whisper-bare' engine.
//
// Config: { binPath = 'whisper-server', modelPath, serverPort = 9095,
//           serverUrl = null, threads, extraArgs = [],
//           startTimeoutMs = 120000, requestTimeoutMs = 30000 }

import { pcm16ToWav, cleanWhisperOutput } from './whisper-cpp-subprocess.mjs'

export const DEFAULT_SERVER_PORT = 9095

// whisper-server startup args. Same decode policy as the whisper-cli engine
// (greedy single-pass: -bs 1 -bo 1 -nf — see buildWhisperArgs for the why) and
// the same extraArgs-last contract so a user flag wins. Unlike whisper-cli the
// server defaults its language to 'en', so 'auto' must be passed explicitly.
// Pure + testable.
export function buildServerArgs ({ modelPath, host = '127.0.0.1', port = DEFAULT_SERVER_PORT, locale, threads, extraArgs = [] }) {
    const args = [
        '-m', modelPath, '--host', host, '--port', String(port),
        '-nt', '-bs', '1', '-bo', '1', '-nf',
        '-l', locale && locale !== '' ? locale : 'auto',
    ]
    if (Number.isInteger(threads) && threads > 0) args.push('-t', String(threads))
    return args.concat(extraArgs)
}

export function createWhisperServerStt ({ config = {}, logger = null } = {}) {
    const binPath = config.binPath || 'whisper-server'
    const modelPath = config.modelPath || null
    const serverUrl = typeof config.serverUrl === 'string' && config.serverUrl ? config.serverUrl.replace(/\/+$/, '') : null
    const port = Number.isInteger(Number(config.serverPort)) && Number(config.serverPort) > 0
        ? Number(config.serverPort)
        : DEFAULT_SERVER_PORT
    const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : []
    const startTimeoutMs = Number(config.startTimeoutMs) > 0 ? Number(config.startTimeoutMs) : 120000
    const requestTimeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 30000
    const base = serverUrl || `http://127.0.0.1:${port}`
    const log = (m) => { try { logger?.info?.(`[stt:whisper-server] ${m}`) } catch {} }

    let mods = null
    async function load () {
        if (mods) return mods
        const [cp, fs, os] = await Promise.all([
            import('node:child_process'), import('node:fs/promises'), import('node:os'),
        ])
        mods = { cp, fs, os: os.default || os }
        return mods
    }

    let child = null
    let starting = null // single-flight ensureServer promise
    let stopped = false
    let stderrTail = [] // last few stderr lines for spawn-failure diagnostics

    // One readiness probe: any HTTP response (even 404) means the server is up
    // and the model is loaded — whisper-server only starts listening after load.
    async function probe (timeoutMs = 1000) {
        try {
            await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs) })
            return true
        } catch { return false }
    }

    async function waitReady (deadline) {
        while (Date.now() < deadline) {
            if (child === null && !serverUrl) return false // died while loading
            if (await probe()) return true
            await new Promise((r) => setTimeout(r, 250))
        }
        return false
    }

    async function spawnServer () {
        const { cp, os } = await load()
        // Same thread policy as the whisper-cli engine: cap at 8 so work stays on
        // performance cores. Overridable via config.threads.
        const threads = Number(config.threads) > 0
            ? Number(config.threads)
            : Math.min(8, os.availableParallelism?.() || os.cpus?.().length || 4)
        const args = buildServerArgs({ modelPath, port, locale: config.locale, threads, extraArgs })
        stderrTail = []
        const proc = cp.spawn(binPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        proc.stderr.on('data', (buf) => {
            stderrTail = stderrTail.concat(String(buf).split('\n').filter(Boolean)).slice(-8)
        })
        proc.on('error', (err) => { log(`spawn error: ${err?.message || err}`); if (child === proc) child = null })
        proc.on('exit', (code, signal) => {
            log(`server exited (code=${code} signal=${signal})${stderrTail.length ? ` — ${stderrTail.at(-1)}` : ''}`)
            if (child === proc) child = null
        })
        child = proc
        log(`spawned ${binPath} on :${port} (pid ${proc.pid})`)
    }

    // Make sure a server is answering at `base`. Managed mode spawns (or adopts
    // an already-listening server on the port); external mode only verifies.
    async function ensureServer () {
        if (starting) return starting
        starting = (async () => {
            if (serverUrl) {
                if (await probe(requestTimeoutMs)) return
                throw new Error(`whisper server unreachable at ${base}`)
            }
            if (stopped) throw new Error('whisper server stopped')
            if (child && await probe()) return
            if (!child && await probe()) { log(`adopted already-running server on :${port}`); return }
            if (!child) {
                if (!modelPath) throw new Error('whisper model not configured (config.voice.modelPath)')
                await spawnServer()
            }
            // Model load gates readiness — generous budget (cold disk can be slow).
            if (!await waitReady(Date.now() + startTimeoutMs)) {
                const detail = stderrTail.at(-1) ? ` — ${stderrTail.at(-1)}` : ''
                throw new Error(`whisper server not ready on :${port} within ${startTimeoutMs}ms${detail}`)
            }
        })().finally(() => { starting = null })
        return starting
    }

    async function available () {
        if (serverUrl) return probe(2000)
        if (!modelPath) return false
        try { const { fs } = await load(); await fs.access(modelPath); return true } catch { return false }
    }

    async function postInference ({ pcm, sampleRate, locale }) {
        const form = new FormData()
        form.append('file', new Blob([pcm16ToWav(pcm, sampleRate)], { type: 'audio/wav' }), 'utterance.wav')
        form.append('response_format', 'json')
        // Per-request language override (the server accepts 'auto' too), so one
        // warm server serves whatever locale each utterance asks for.
        form.append('language', locale && locale !== '' ? locale : 'auto')
        const res = await fetch(`${base}/inference`, {
            method: 'POST', body: form, signal: AbortSignal.timeout(requestTimeoutMs),
        })
        if (!res.ok) throw new Error(`whisper server HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
        const body = await res.json()
        if (typeof body?.text !== 'string') throw new Error(`whisper server returned no text (${JSON.stringify(body).slice(0, 200)})`)
        return cleanWhisperOutput(body.text)
    }

    async function transcribe ({ pcm, sampleRate = 16000, locale = 'auto' }) {
        await ensureServer()
        let text
        try {
            text = await postInference({ pcm, sampleRate, locale })
        } catch (err) {
            // A managed server that died mid-flight gets one respawn + retry;
            // external servers (and HTTP-level errors) fail straight through.
            if (serverUrl || stopped) throw err
            log(`inference failed (${err?.message || err}); restarting server and retrying once`)
            try { child?.kill() } catch {}
            child = null
            await ensureServer()
            text = await postInference({ pcm, sampleRate, locale })
        }
        log(`transcribed ${pcm.length} bytes -> "${text.slice(0, 60)}"`)
        return { text, locale }
    }

    // Kill the managed child (idempotent). The service calls this on shutdown so
    // a stopped host never leaves an orphan whisper-server holding the model.
    async function stop () {
        stopped = true
        if (child) { try { child.kill() } catch {} child = null }
    }

    // Eager warm-up: hosts call this (fire-and-forget) right after boot so the
    // model load happens before the first utterance arrives — a lazy first
    // spawn could otherwise exceed the leaf's 25 s feedback window cold.
    const start = () => ensureServer()

    return { engine: 'whisper-server', available, transcribe, start, stop }
}
