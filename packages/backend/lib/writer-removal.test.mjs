import test from 'node:test'
import assert from 'node:assert/strict'
import { removeWriterAtConsensus } from './writer-removal.mjs'

const writerKey = Buffer.from('ab'.repeat(32), 'hex')

function collectLogger() {
    const lines = []
    return { logger: { log: (...args) => lines.push(args.join(' ')) }, lines }
}

test('a successful Autobase removal reports removed:true', async () => {
    const removed = []
    const { logger } = collectLogger()
    const host = {
        removeable: () => true,
        async removeWriter(key) { removed.push(key.toString('hex')) },
    }

    const outcome = await removeWriterAtConsensus({ host, writerKey, logger })

    assert.deepEqual(outcome, { removed: true, reason: null })
    assert.deepEqual(removed, [writerKey.toString('hex')])
})

test('a runtime without removeWriter is reported loudly, not swallowed', async () => {
    const { logger, lines } = collectLogger()

    const outcome = await removeWriterAtConsensus({ host: {}, writerKey, logger })

    assert.deepEqual(outcome, { removed: false, reason: 'unsupported' })
    assert.ok(lines.some((l) => l.includes('[ERROR]') && l.includes('does not support')))
})

test('a writer Autobase refuses to remove is reported as not-removable', async () => {
    const { logger, lines } = collectLogger()
    let removeCalled = false
    const host = {
        removeable: () => false,
        async removeWriter() { removeCalled = true },
    }

    const outcome = await removeWriterAtConsensus({ host, writerKey, logger })

    assert.deepEqual(outcome, { removed: false, reason: 'not-removable' })
    assert.equal(removeCalled, false)
    assert.ok(lines.some((l) => l.includes('[ERROR]') && l.includes('not removable')))
})

test('a removeWriter that throws is caught and reported, not swallowed', async () => {
    const { logger, lines } = collectLogger()
    const host = {
        removeable: () => true,
        async removeWriter() { throw new Error('boom') },
    }

    const outcome = await removeWriterAtConsensus({ host, writerKey, logger })

    assert.deepEqual(outcome, { removed: false, reason: 'error' })
    assert.ok(lines.some((l) => l.includes('[ERROR]') && l.includes('Failed to remove writer')))
})

test('removeable is optional: removal proceeds when the host does not expose it', async () => {
    const removed = []
    const { logger } = collectLogger()
    const host = { async removeWriter(key) { removed.push(key.toString('hex')) } }

    const outcome = await removeWriterAtConsensus({ host, writerKey, logger })

    assert.equal(outcome.removed, true)
    assert.deepEqual(removed, [writerKey.toString('hex')])
})
