import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { createUtteranceDataset } from './voice-dataset.mjs'

async function tmpDir () {
    return fs.mkdtemp(`${os.tmpdir()}/voice-dataset-`)
}

// monotonically increasing fake clock so filenames sort by age deterministically
function fakeClock (start = 1_700_000_000_000) {
    let t = start
    return () => (t += 1000)
}

const utt = (overrides = {}) => ({
    pcm: Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]),
    sampleRate: 16000,
    wakeWordId: 1,
    reason: 'silence',
    bytes: 8,
    durationMs: 1,
    ...overrides,
})

test('save() writes a valid WAV + JSON sidecar, labeled by the wake result', async () => {
    const dir = await tmpDir()
    const ds = createUtteranceDataset({ dir, fs, now: fakeClock() })
    const wavPath = await ds.save(utt({ wake: { fired: true, prob: 0.996, featPeak: 626 } }))
    assert.ok(wavPath?.endsWith('.wav'))
    assert.match(wavPath, /_fired-yes_p996_silence\.wav$/)

    const wav = await fs.readFile(wavPath)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    assert.equal(wav.length, 44 + 8) // header + pcm

    const meta = JSON.parse(await fs.readFile(wavPath.replace(/\.wav$/, '.json'), 'utf8'))
    assert.equal(meta.reason, 'silence')
    assert.deepEqual(meta.wake, { fired: true, prob: 0.996, featPeak: 626 })
    assert.equal(meta.sampleRate, 16000)
})

test('labels hard-negatives and unlabeled (old firmware) distinctly', async () => {
    const dir = await tmpDir()
    const ds = createUtteranceDataset({ dir, fs, now: fakeClock() })
    const neg = await ds.save(utt({ wake: { fired: false, prob: 0.03, featPeak: 590 } }))
    const unk = await ds.save(utt({ wake: undefined }))
    assert.match(neg, /_fired-no_p30_/)
    assert.match(unk, /_fired-unk_silence\.wav$/) // no _p<milli> when unlabeled
})

test('prunes oldest clips past maxFiles (wav + sidecar together)', async () => {
    const dir = await tmpDir()
    const ds = createUtteranceDataset({ dir, fs, maxFiles: 3, now: fakeClock() })
    for (let i = 0; i < 6; i++) await ds.save(utt({ wake: { fired: false, prob: 0.01, featPeak: 100 + i } }))
    const files = (await fs.readdir(dir)).sort()
    const wavs = files.filter((f) => f.endsWith('.wav'))
    const jsons = files.filter((f) => f.endsWith('.json'))
    assert.equal(wavs.length, 3, 'keeps only the cap')
    assert.equal(jsons.length, 3, 'sidecars pruned in lockstep')
    // the 3 survivors are the newest (featPeak 103,104,105 by our increasing clock)
    assert.equal(wavs.every((f) => /_p10_/.test(f)), true)
})

test('save() never throws and returns null on empty pcm', async () => {
    const dir = await tmpDir()
    const ds = createUtteranceDataset({ dir, fs, now: fakeClock() })
    assert.equal(await ds.save({ pcm: Buffer.alloc(0) }), null)
    assert.equal(await ds.save(null), null)
})
