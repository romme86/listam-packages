import test from 'node:test'
import assert from 'node:assert/strict'
import {
    formatLogLine,
    parseLogArgs,
    redactDiagnosticBundle,
    redactForExport,
    redactForLog,
    redactString,
} from './index.mjs'

test('logging redacts key and invite-shaped strings', () => {
    const hex = 'a'.repeat(64)
    const invite = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(2)

    assert.equal(redactString(`key=${hex}`), 'key=[redacted-hex]')
    assert.equal(redactString(`https://listam.ch/join?invite=${invite}`), 'https://listam.ch/join?invite=[redacted]')
})

test('logging redacts sensitive object fields and item payloads', () => {
    assert.deepEqual(redactForLog({
        key: Buffer.from('abc'),
        value: { text: 'Milk', isDone: false, timeOfCompletion: 0 },
        items: [{ text: 'Eggs', isDone: true, timeOfCompletion: 123 }],
    }), {
        key: '[redacted]',
        value: '[redacted]',
        items: '[items:1]',
    })
})

test('logging formats structured JSON lines with app labels', () => {
    const row = parseLogArgs(['[WARNING] Link', { invite: 'secret' }], { app: 'shared' })
    assert.equal(row.level, 'warn')
    assert.equal(row.app, 'shared')
    assert.equal(JSON.parse(formatLogLine(['[INFO] Ready'])).message, 'Ready')
})

test('logging redacts loyalty-card payloads in exports and diagnostics', () => {
    const cardPayload = '9824516530999'
    const source = {
        reduxState: {
            loyaltyCards: {
                cardsById: {
                    coop: {
                        id: 'coop',
                        name: 'Coop',
                        type: 'ean13',
                        payloadRef: 'card.coop',
                    },
                },
            },
        },
        export: {
            loyaltyCards: [
                { id: 'coop', name: 'Coop', type: 'ean13', data: cardPayload },
            ],
        },
        diagnostics: {
            loyaltyCardPayload: cardPayload,
            lastScan: `barcode=${cardPayload}`,
        },
    }

    const redactedExport = redactForExport(source)
    const redactedDiagnostics = redactDiagnosticBundle(source)

    assert.equal(JSON.stringify(redactedExport).includes(cardPayload), false)
    assert.equal(JSON.stringify(redactedDiagnostics).includes(cardPayload), false)
    assert.equal(JSON.stringify(source.reduxState).includes(cardPayload), false)
    assert.equal(redactString(`barcode=${cardPayload}`), 'barcode=[redacted-card]')
})
