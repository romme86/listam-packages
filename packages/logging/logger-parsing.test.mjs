import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLogArgs, redactForLog, redactString } from './index.mjs'

test('redacts key and invite-shaped strings', () => {
    const hex = 'a'.repeat(64)
    const invite = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(2)

    assert.equal(redactString(`key=${hex}`), 'key=[redacted-hex]')
    assert.equal(redactString(`https://listam.ch/join?invite=${invite}`), 'https://listam.ch/join?invite=[redacted]')
})

test('redacts byte buffers, sensitive object fields, and item payloads', () => {
    const redacted = redactForLog({
        command: 42,
        key: Buffer.from('abc'),
        value: { text: 'Milk', isDone: false, timeOfCompletion: 0 },
        items: [{ text: 'Eggs', isDone: true, timeOfCompletion: 123 }],
    })

    assert.deepEqual(redacted, {
        command: 42,
        key: '[redacted]',
        value: '[redacted]',
        items: '[items:1]',
    })
})

test('parses level prefixes into structured rows', () => {
    const row = parseLogArgs(['[ERROR] Failed to join', new Error('secret ' + 'f'.repeat(64))])

    assert.equal(row.level, 'error')
    assert.equal(row.app, 'backend')
    assert.equal(row.message, 'Failed to join')
    assert.deepEqual(row.details, [
        {
            name: 'Error',
            message: 'secret [redacted-hex]'
        }
    ])
})
