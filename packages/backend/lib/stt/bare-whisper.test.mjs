import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import { pcm16ToWavBytes, createWhisperBareStt } from './bare-whisper.mjs'
import { pcm16ToWav, buildWhisperArgs } from './whisper-cpp-subprocess.mjs'

test('pcm16ToWavBytes is byte-identical to the Node pcm16ToWav', () => {
    const pcm = b4a.from([0, 1, 2, 3, 250, 251, 252, 253])
    const bare = pcm16ToWavBytes(pcm, 16000)
    const node = pcm16ToWav(pcm, 16000)
    assert.equal(bare.length, node.length)
    assert.ok(b4a.equals(b4a.from(bare), b4a.from(node)), 'WAV bytes differ from the Node builder')
    // Spot-check the RIFF/WAVE/fmt /data tags + sample rate.
    assert.equal(b4a.toString(b4a.from(bare).subarray(0, 4)), 'RIFF')
    assert.equal(b4a.toString(b4a.from(bare).subarray(8, 12)), 'WAVE')
    const dv = new DataView(b4a.from(bare).buffer)
})

// Minimal bare-subprocess mock: spawn returns a child that emits stdout then exit.
function mockSubprocess (stdoutText, exitCode = 0, throwOnSpawn = false) {
    return {
        spawn () {
            if (throwOnSpawn) throw new Error('spawn failed')
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            queueMicrotask(() => {
                child.stdout.emit('data', b4a.from(stdoutText))
                child.emit('exit', exitCode)
            })
            return child
        },
    }
}

const wrote = []
function mockFs (modelExists = true) {
    return {
        statSync (p) { if (p.includes('missing')) throw new Error('ENOENT'); if (!modelExists) throw new Error('ENOENT'); return {} },
        writeFileSync (p, data) { wrote.push({ p, len: data.length }) },
        unlinkSync () {},
    }
}

test('available() reflects the model file presence', async () => {
    const subprocess = mockSubprocess('')
    assert.equal(await createWhisperBareStt({ config: { modelPath: '/m/ggml.bin' }, subprocess, fs: mockFs(true) }).available(), true)
    assert.equal(await createWhisperBareStt({ config: { modelPath: '/m/ggml.bin' }, subprocess, fs: mockFs(false) }).available(), false)
    assert.equal(await createWhisperBareStt({ config: {}, subprocess, fs: mockFs(true) }).available(), false) // no model
    assert.equal(await createWhisperBareStt({ config: { modelPath: '/m/ggml.bin' }, subprocess: null, fs: mockFs(true) }).available(), false) // no subprocess
})

test('transcribe spawns whisper, writes the WAV, and returns cleaned text', async () => {
    wrote.length = 0
    const stt = createWhisperBareStt({
        config: { binPath: 'whisper-cli', modelPath: '/m/ggml-medium.bin', extraArgs: ['--prompt', 'aggiungi'] },
        subprocess: mockSubprocess('[00:00.000 --> 00:02.000]   aggiungi latte\n'),
        fs: mockFs(true),
        tmpDir: '/tmp/x',
    })
    const res = await stt.transcribe({ pcm: b4a.from([1, 2, 3, 4]), sampleRate: 16000, locale: 'it' })
    assert.equal(res.text, 'aggiungi latte')
    assert.equal(res.locale, 'it')
    assert.equal(wrote.length, 1)
    assert.ok(wrote[0].p.startsWith('/tmp/x/listam-voice-'))
    assert.ok(wrote[0].p.endsWith('.wav'))
    // args wiring: locale + prompt threaded through buildWhisperArgs
    assert.deepEqual(
        buildWhisperArgs({ modelPath: '/m/ggml-medium.bin', wavPath: '/tmp/x/a.wav', locale: 'it', extraArgs: ['--prompt', 'aggiungi'] }),
        ['-m', '/m/ggml-medium.bin', '-f', '/tmp/x/a.wav', '-nt', '-np', '-bs', '1', '-bo', '1', '-nf', '-l', 'it', '--prompt', 'aggiungi'],
    )
})

test('transcribe rejects on non-zero exit', async () => {
    const stt = createWhisperBareStt({
        config: { modelPath: '/m/ggml.bin' },
        subprocess: mockSubprocess('', 3),
        fs: mockFs(true),
    })
    await assert.rejects(() => stt.transcribe({ pcm: b4a.from([1, 2]) }), /exited 3/)
})

test('engine id is whisper-bare', () => {
    assert.equal(createWhisperBareStt({ config: {} }).engine, 'whisper-bare')
})
