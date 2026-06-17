import test from 'node:test'
import assert from 'node:assert/strict'
import { pcm16ToWav, buildWhisperArgs, cleanWhisperOutput } from './whisper-cpp-subprocess.mjs'
import { createStt } from './index.mjs'

test('pcm16ToWav writes a valid 44-byte RIFF/WAVE/data header', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
    const wav = pcm16ToWav(pcm, 16000)
    assert.equal(wav.length, 44 + pcm.length)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    assert.equal(wav.toString('ascii', 36, 40), 'data')
    assert.equal(wav.readUInt32LE(24), 16000) // sample rate
    assert.equal(wav.readUInt16LE(22), 1) // mono
    assert.equal(wav.readUInt16LE(34), 16) // bits per sample
    assert.equal(wav.readUInt32LE(40), pcm.length) // data length
})

test('buildWhisperArgs includes the model + wav and respects locale', () => {
    const withLocale = buildWhisperArgs({ modelPath: '/m.bin', wavPath: '/a.wav', locale: 'it' })
    assert.ok(withLocale.includes('-m') && withLocale.includes('/m.bin'))
    assert.ok(withLocale.includes('-f') && withLocale.includes('/a.wav'))
    assert.deepEqual(withLocale.slice(withLocale.indexOf('-l')), ['-l', 'it'])

    const auto = buildWhisperArgs({ modelPath: '/m.bin', wavPath: '/a.wav', locale: 'auto' })
    assert.ok(!auto.includes('-l')) // auto-detect => no -l flag
})

test('cleanWhisperOutput strips timestamp tags and collapses whitespace', () => {
    assert.equal(cleanWhisperOutput('[00:00:00.000 --> 00:00:02.000]   add milk to groceries\n'), 'add milk to groceries')
    assert.equal(cleanWhisperOutput('  hello   world \n\n'), 'hello world')
})

test('createStt: fixture engine, disabled engine, unknown engine', async () => {
    const fx = createStt({ engine: 'fixture', config: { transcribe: async () => ({ text: 'hi', locale: 'en' }) } })
    assert.equal(await fx.available(), true)
    assert.deepEqual(await fx.transcribe({ pcm: Buffer.alloc(0) }), { text: 'hi', locale: 'en' })

    const off = createStt({ engine: 'none' })
    assert.equal(await off.available(), false)

    assert.throws(() => createStt({ engine: 'bogus' }), /unknown STT engine/)
})

test('whisper-cpp engine reports unavailable without a configured model', async () => {
    const stt = createStt({ engine: 'whisper-cpp', config: {} })
    assert.equal(await stt.available(), false)
})
