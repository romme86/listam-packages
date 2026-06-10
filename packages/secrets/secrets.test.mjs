import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createDeleteSecretPayload,
    createPersistSecretPayload,
    LEGACY_LOYALTY_CARDS_KEY,
    LOYALTY_CARD_HANDLES_KEY,
    normalizeSecretValue,
    parseBackendSecretPayload,
    parseSecretAck,
    prepareLoyaltyCardPayloads,
    readLoyaltyCardPayload,
    secretFingerprint,
    loyaltyCardPayloadStoreKey,
    persistLoyaltyCardPayload,
    toLoyaltyCardHandle,
} from './index.mjs'

test('secrets normalize supported key material and reject malformed values', () => {
    assert.equal(normalizeSecretValue('autobaseKey', 'A'.repeat(64)), 'a'.repeat(64))
    assert.equal(normalizeSecretValue('ownerAuthorityKey', Buffer.alloc(64, 1)), '01'.repeat(64))
    assert.equal(normalizeSecretValue('epochKey', 'a'.repeat(128)), null)
    assert.equal(normalizeSecretValue('unknown', 'a'.repeat(64)), null)
})

test('secrets parse boot payloads without leaking invalid values', () => {
    const parsed = parseBackendSecretPayload(JSON.stringify({
        version: 1,
        mode: 'secure-store',
        secrets: {
            autobaseKey: 'b'.repeat(64),
            ownerAuthorityKey: 'bad',
        },
    }))

    assert.deepEqual(parsed.secrets, { autobaseKey: 'b'.repeat(64) })
})

test('secrets build persistence payloads and parse acknowledgements', () => {
    const payload = createPersistSecretPayload('epochKey', 'c'.repeat(64))
    assert.equal(payload.fingerprint, secretFingerprint('c'.repeat(64)))
    assert.equal(createDeleteSecretPayload('epochKey').op, 'delete')
    assert.equal(parseSecretAck(JSON.stringify({ stored: true })), true)
    assert.equal(parseSecretAck(JSON.stringify({ stored: false })), false)
})

test('loyalty-card migration moves payloads into secure storage and stores handles only', async () => {
    const card = {
        id: 'coop',
        name: 'Coop',
        type: 'ean13',
        data: '9824516530999',
    }
    const secure = createSecureStore()
    const asyncStorage = createKeyValueStore({
        [LEGACY_LOYALTY_CARDS_KEY]: JSON.stringify([card]),
    })

    const prepared = await prepareLoyaltyCardPayloads({
        secureStore: secure.adapter,
        handleStore: asyncStorage.adapter,
        legacyStore: asyncStorage.adapter,
        metadataStore: asyncStorage.adapter,
    })

    assert.equal(prepared.mode, 'secure-store')
    assert.equal(prepared.migratedCount, 1)
    assert.deepEqual(prepared.handles, [toLoyaltyCardHandle(card)])
    assert.equal(asyncStorage.values.has(LEGACY_LOYALTY_CARDS_KEY), false)

    const handleJson = asyncStorage.values.get(LOYALTY_CARD_HANDLES_KEY)
    assert.equal(handleJson.includes(card.data), false)
    assert.deepEqual(JSON.parse(handleJson), [toLoyaltyCardHandle(card)])

    const stored = secure.values.get(loyaltyCardPayloadStoreKey(prepared.handles[0].payloadRef))
    assert.equal(JSON.parse(stored).data, card.data)

    const loaded = await readLoyaltyCardPayload(prepared.handles[0], {
        secureStore: secure.adapter,
        legacyStore: asyncStorage.adapter,
    })
    assert.deepEqual(loaded, card)
})

test('loyalty-card migration is idempotent and keeps handle state redaction-safe', async () => {
    const card = {
        id: 'migros',
        name: 'Migros',
        type: 'qr',
        data: 'loyalty-card-secret-payload',
    }
    const secure = createSecureStore()
    const asyncStorage = createKeyValueStore({
        [LEGACY_LOYALTY_CARDS_KEY]: JSON.stringify([card]),
    })

    const first = await prepareLoyaltyCardPayloads({
        secureStore: secure.adapter,
        handleStore: asyncStorage.adapter,
        legacyStore: asyncStorage.adapter,
    })
    const second = await prepareLoyaltyCardPayloads({
        secureStore: secure.adapter,
        handleStore: asyncStorage.adapter,
        legacyStore: asyncStorage.adapter,
    })

    assert.deepEqual(first.handles, second.handles)
    assert.equal(second.migratedCount, 0)
    assert.equal(JSON.stringify(second.handles).includes(card.data), false)
    assert.equal(asyncStorage.values.has(LEGACY_LOYALTY_CARDS_KEY), false)

    const added = await persistLoyaltyCardPayload({
        id: 'manor',
        name: 'Manor',
        type: 'code128',
        data: 'new-card-secret',
    }, {
        secureStore: secure.adapter,
        handleStore: asyncStorage.adapter,
        legacyStore: asyncStorage.adapter,
    })

    assert.equal(JSON.stringify(added.handle).includes('new-card-secret'), false)
    assert.equal(asyncStorage.values.get(LOYALTY_CARD_HANDLES_KEY).includes('new-card-secret'), false)
})

function createSecureStore(options = {}) {
    const values = new Map(Object.entries(options.values ?? {}))
    return {
        values,
        adapter: {
            async isAvailable() {
                return options.available ?? true
            },
            async getItem(key) {
                return values.get(key) ?? null
            },
            async setItem(key, value) {
                values.set(key, value)
            },
            async deleteItem(key) {
                values.delete(key)
            },
        },
    }
}

function createKeyValueStore(initialValues = {}) {
    const values = new Map(Object.entries(initialValues))
    return {
        values,
        adapter: {
            async getItem(key) {
                return values.get(key) ?? null
            },
            async setItem(key, value) {
                values.set(key, value)
            },
            async removeItem(key) {
                values.delete(key)
            },
        },
    }
}
