// whisper-server engine: startup-args builder, external (serverUrl) inference
// against a mock HTTP server, managed-mode spawn/adopt/stop lifecycle. The mock
// speaks just enough of whisper-server's /inference contract ({"text": ...})
// that no real whisper.cpp build or model is needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServerArgs, createWhisperServerStt } from './whisper-server.mjs'
import { createStt } from './index.mjs'

const PCM = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])

function listen (handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler)
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
    })
}

test('buildServerArgs: bind, greedy decode flags, explicit auto locale, extraArgs last', () => {
    const args = buildServerArgs({ modelPath: '/m.bin', port: 9095, locale: 'it', threads: 4, extraArgs: ['-ac', '768'] })
    assert.deepEqual(args.slice(0, 2), ['-m', '/m.bin'])
    assert.deepEqual(args.slice(args.indexOf('--port'), args.indexOf('--port') + 2), ['--port', '9095'])
    assert.ok(args.includes('-bs') && args.includes('-bo') && args.includes('-nf'))
    assert.deepEqual(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2), ['-l', 'it'])
    assert.deepEqual(args.slice(-2), ['-ac', '768']) // extraArgs win by coming last

    // whisper-server defaults its language to 'en', so 'auto' must be explicit
    const auto = buildServerArgs({ modelPath: '/m.bin', locale: 'auto' })
    assert.deepEqual(auto.slice(auto.indexOf('-l'), auto.indexOf('-l') + 2), ['-l', 'auto'])
    const none = buildServerArgs({ modelPath: '/m.bin' })
    assert.deepEqual(none.slice(none.indexOf('-l'), none.indexOf('-l') + 2), ['-l', 'auto'])
})

test('external serverUrl mode: POSTs multipart WAV + language, returns cleaned text', async () => {
    const requests = []
    const { srv, port } = await listen((req, res) => {
        if (req.method === 'POST' && req.url === '/inference') {
            const chunks = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => {
                requests.push({ headers: req.headers, body: Buffer.concat(chunks) })
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ text: ' io aggiungi latte\n' }))
            })
            return
        }
        res.end('ok') // readiness probe
    })
    try {
        const stt = createWhisperServerStt({ config: { serverUrl: `http://127.0.0.1:${port}` } })
        assert.equal(stt.engine, 'whisper-server')
        assert.equal(await stt.available(), true)
        const out = await stt.transcribe({ pcm: PCM, sampleRate: 16000, locale: 'it' })
        assert.deepEqual(out, { text: 'io aggiungi latte', locale: 'it' })

        assert.equal(requests.length, 1)
        assert.match(requests[0].headers['content-type'], /multipart\/form-data/)
        const body = requests[0].body.toString('latin1')
        assert.ok(body.includes('name="file"'), 'multipart carries the audio file part')
        assert.ok(body.includes('RIFF'), 'file part is a WAV (RIFF header)')
        assert.ok(body.includes('name="language"') && body.includes('it'), 'per-request language override sent')
        assert.ok(body.includes('name="response_format"'), 'json response format requested')

        await stt.stop() // no-op for external servers
        assert.equal(await stt.available(), true)
    } finally {
        srv.close()
    }
})

test('external serverUrl mode: HTTP error surfaces (no managed respawn)', async () => {
    const { srv, port } = await listen((req, res) => {
        if (req.method === 'POST') { res.statusCode = 500; res.end('boom'); return }
        res.end('ok')
    })
    try {
        const stt = createWhisperServerStt({ config: { serverUrl: `http://127.0.0.1:${port}` } })
        await assert.rejects(() => stt.transcribe({ pcm: PCM }), /HTTP 500/)
    } finally {
        srv.close()
    }
})

test('managed mode: adopts an already-listening server instead of spawning', async () => {
    const { srv, port } = await listen((req, res) => {
        if (req.method === 'POST') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ text: ' adopted\n' }))
            return
        }
        res.end('ok')
    })
    try {
        // binPath that would fail if a spawn were attempted — adoption must win.
        const stt = createWhisperServerStt({
            config: { binPath: '/nonexistent/whisper-server', modelPath: '/nonexistent/model.bin', serverPort: port },
        })
        const out = await stt.transcribe({ pcm: PCM, sampleRate: 16000, locale: 'en' })
        assert.equal(out.text, 'adopted')
    } finally {
        srv.close()
    }
})

test('managed mode: spawns the server binary, transcribes, and stop() kills it', async (t) => {
    // Stand-in "whisper-server": an extensionless CJS node script (shebang) that
    // parses --port from argv and answers the readiness probe + /inference.
    const dir = await mkdtemp(path.join(tmpdir(), 'listam-wserver-test-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const stub = path.join(dir, 'fake-whisper-server')
    await writeFile(stub, [
        '#!/usr/bin/env node',
        "const http = require('node:http')",
        "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
        'http.createServer((req, res) => {',
        "    if (req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: ' spawned ok\\n' })); return }",
        "    res.end('ok')",
        "}).listen(port, '127.0.0.1')",
        '',
    ].join('\n'))
    await chmod(stub, 0o755)
    // The stub's `#!/usr/bin/env node` must resolve even when the test runner's
    // PATH lacks the node bin dir (direct `node --test` invocation).
    const nodeDir = path.dirname(process.execPath)
    if (!(process.env.PATH || '').split(path.delimiter).includes(nodeDir)) {
        process.env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH || ''}`
    }

    const port = 10000 + (process.pid % 40000)
    const stt = createStt({
        engine: 'whisper-server',
        // modelPath must exist for available(); the stub file itself will do.
        config: { binPath: stub, modelPath: stub, serverPort: port, startTimeoutMs: 15000 },
    })
    assert.equal(await stt.available(), true)
    const out = await stt.transcribe({ pcm: PCM, sampleRate: 16000, locale: 'it' })
    assert.equal(out.text, 'spawned ok')

    await stt.stop()
    // The managed child is gone and the engine refuses further work.
    await assert.rejects(() => stt.transcribe({ pcm: PCM }), /stopped/)
})
