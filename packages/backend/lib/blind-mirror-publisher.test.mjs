import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBlindMirrorPublisher } from './blind-mirror-publisher.mjs'
import { collectMirrorKeys } from './blind-manifest.mjs'

const A = '11'.repeat(32), B = '22'.repeat(32), C = '33'.repeat(32), D = '44'.repeat(32)
test('mirror publisher follows writer/view changes, retries after restart and stops while suspended', async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'listam-mirror-publisher-'))
    const path = join(root, 'mirrors.json')
    const ctx = { autobase: { opened: true, key: Buffer.from(A, 'hex'), core: { key: Buffer.from(B, 'hex') }, view: { key: Buffer.from(C, 'hex') }, activeWriters: [] } }
    const sent = []
    let suspended = false, available = true
    const options = { fs, path, getContext: () => ctx, isSuspended: () => suspended, send: async (_server, _command, payload) => {
        const persisted = JSON.parse(fs.readFileSync(path, 'utf8'))
        assert.equal(persisted.records[0].manifest.revision, payload.manifest.revision)
        sent.push(structuredClone(payload.manifest)); return { ok: available }
    } }
    let publisher = createBlindMirrorPublisher(options)
    t.after(() => { publisher.stop(); fs.rmSync(root, { recursive: true, force: true }) })
    await publisher.configure(D, A)
    assert.deepEqual(sent.at(-1).keys, [A, B, C])
    ctx.autobase.activeWriters.push({ core: { key: Buffer.from(D, 'hex') } })
    suspended = true
    await publisher.refresh()
    assert.equal(sent.length, 1)
    suspended = false; available = false
    await publisher.refresh()
    const revision = sent.at(-1).revision
    publisher.stop(); publisher = createBlindMirrorPublisher(options)
    available = true
    await publisher.refresh()
    assert.equal(sent.at(-1).revision, revision, 'retry the persisted revision')
    assert.deepEqual(sent.at(-1).keys, [A, B, C, D])
    ctx.autobase.activeWriters = []
    await publisher.refresh()
    assert.deepEqual(sent.at(-1).keys, [A, B, C, D], 'retain old writers for causal-history recovery')
    await publisher.configure(D, A, false)
    assert.deepEqual(sent.at(-1).keys, [])
    assert.ok(sent.at(-1).revision > revision)
})

test('mirror collector includes membership history and refuses a closing base', () => {
    const ctx = { autobase: { opened: true, key: Buffer.from(A, 'hex') }, membershipState: { writers: new Set([B]), removedWriters: new Map([[C, {}]]) } }
    assert.deepEqual(collectMirrorKeys(ctx), [A, B, C])
    ctx.autobase.closing = true
    assert.equal(collectMirrorKeys(ctx), null)
})
