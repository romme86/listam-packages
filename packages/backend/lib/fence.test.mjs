import test from 'node:test'
import assert from 'node:assert/strict'
import { clearFence, fence, fenceReason, fenceState, isFenced } from './fence.mjs'
import { clearWriteChain, enqueueWrite } from './item.mjs'

test.afterEach(() => clearFence())

test('a fresh process is not fenced', () => {
    assert.equal(isFenced(), false)
    assert.equal(fenceReason(), null)
    assert.equal(fenceState(), null)
})

test('fence latches and reports its reason', () => {
    fence('storage-lease-lost', 1234)
    assert.equal(isFenced(), true)
    assert.equal(fenceReason(), 'storage-lease-lost')
    assert.deepEqual(fenceState(), { reason: 'storage-lease-lost', at: 1234 })
})

test('the FIRST reason wins — a cascade cannot overwrite the true cause', () => {
    // Losing the lease tends to make the next few operations fail too. If each
    // failure re-fenced, the reported cause would be whatever failed last
    // instead of the one that matters.
    fence('storage-lease-lost', 1)
    fence('store-closed', 2)
    fence('whatever', 3)
    assert.deepEqual(fenceState(), { reason: 'storage-lease-lost', at: 1 })
})

test('fencing is one-way within a process; only an explicit reset clears it', () => {
    fence('storage-lease-lost')
    assert.equal(isFenced(), true)
    clearFence()
    assert.equal(isFenced(), false, 'clearFence is the test/reinit hook, not a recovery path')
})

test('a malformed reason still fences', () => {
    fence('')
    assert.equal(isFenced(), true)
    assert.equal(fenceReason(), 'unknown')
})

test('a fenced backend cannot append: the writer is never invoked', async () => {
    // The acceptance criterion for lease loss. A healthy writer that would
    // otherwise run must not run once fenced — two writers on one Corestore
    // root is precisely the corruption the lease exists to prevent.
    const ctx = {
        role: 'shared',
        baseId: 'fence-test-base',
        autobase: { closing: false, localWriter: { closed: false, idle: () => true } },
    }
    try {
        let invoked = 0
        const before = await enqueueWrite(async () => { invoked++; return true }, ctx)
        assert.equal(before, true, 'sanity: this writer runs while unfenced')
        assert.equal(invoked, 1)

        fence('storage-lease-lost')

        const after = await enqueueWrite(async () => { invoked++; return true }, ctx)
        assert.equal(after, false, 'a fenced write must be refused')
        assert.equal(invoked, 1, 'the writer must never be invoked while fenced')
    } finally {
        clearWriteChain(ctx)
    }
})
