import test from 'node:test'
import assert from 'node:assert/strict'
import { clearWriteChain, enqueueWrite } from './item.mjs'

test('the shared write queue refuses before invoking a writer when its base is closing', async () => {
    const ctx = {
        role: 'shared',
        baseId: 'closing-test-base',
        autobase: { closing: true },
    }
    let invoked = false
    try {
        const result = await enqueueWrite(async () => { invoked = true; return true }, ctx)
        assert.equal(result, false)
        assert.equal(invoked, false)
    } finally {
        clearWriteChain(ctx)
    }
})

test('the shared write queue runs a writer only after the local writer is idle', async () => {
    const ctx = {
        role: 'shared',
        baseId: 'idle-test-base',
        autobase: {
            closing: false,
            localWriter: { closed: false, idle: () => true },
        },
    }
    try {
        assert.equal(await enqueueWrite(async () => 'written', ctx), 'written')
    } finally {
        clearWriteChain(ctx)
    }
})

test('the shared write queue refuses when autobase update never settles', async () => {
    const ctx = {
        role: 'shared',
        baseId: 'hanging-update-test-base',
        autobase: {
            closing: false,
            localWriter: { closed: false, idle: () => false },
            update: () => new Promise(() => {}),
        },
    }
    let invoked = false
    const startedAt = Date.now()
    try {
        const result = await enqueueWrite(async () => { invoked = true; return true }, ctx)
        assert.equal(result, false)
        assert.equal(invoked, false)
        assert.ok(Date.now() - startedAt < 2000, 'hanging update must be refused promptly')
    } finally {
        clearWriteChain(ctx)
    }
})
