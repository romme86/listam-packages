import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createInviteQrPayload,
    parseInviteQrPayload,
} from './index.mjs'

const INVITE = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(3) + 'ybndrfg8ej'

test('project and list QR payloads are typed, versioned and round-trip', () => {
    for (const scope of ['project', 'list']) {
        const encoded = createInviteQrPayload(INVITE, scope)
        assert.equal(encoded, `listam-invite://v1/${scope}?invite=${INVITE}`)
        assert.deepEqual(parseInviteQrPayload(encoded), {
            version: 1,
            scope,
            invite: INVITE,
        })
    }
})

test('QR payload creation normalizes invite whitespace', () => {
    const encoded = createInviteQrPayload(`  ${INVITE.slice(0, 50)}\n${INVITE.slice(50)}  `, 'list')
    assert.equal(encoded, `listam-invite://v1/list?invite=${INVITE}`)
})

test('QR payload parsing accepts surrounding and encoded invite whitespace', () => {
    assert.deepEqual(
        parseInviteQrPayload('  listam-invite://v1/project?invite=abc%20def  '),
        { version: 1, scope: 'project', invite: 'abcdef' },
    )
})

test('QR payload parser rejects unrelated, unknown and ambiguous payloads', () => {
    const invalid = [
        null,
        '',
        INVITE,
        `https://listam.ch/join?invite=${INVITE}`,
        `listam://join?invite=${INVITE}`,
        `listam-invite://v2/project?invite=${INVITE}`,
        `listam-invite://v1/team?invite=${INVITE}`,
        `listam-invite://v1/project/?invite=${INVITE}`,
        `listam-invite://v1/project?invite=${INVITE}#fragment`,
        `listam-invite://user@v1/project?invite=${INVITE}`,
        'listam-invite://v1/project',
        'listam-invite://v1/project?invite=',
        'listam-invite://v1/project?invite=not-an-invite!',
        `listam-invite://v1/project?invite=${INVITE}&invite=other`,
        `listam-invite://v1/project?invite=${INVITE}&source=qr`,
    ]

    for (const value of invalid) {
        assert.equal(parseInviteQrPayload(value), null, String(value))
    }
})

test('QR payload creation rejects invalid invites and scopes', () => {
    assert.throws(() => createInviteQrPayload('', 'project'), TypeError)
    assert.throws(() => createInviteQrPayload('contains-punctuation', 'project'), TypeError)
    assert.throws(() => createInviteQrPayload(INVITE, 'workspace'), TypeError)
})
