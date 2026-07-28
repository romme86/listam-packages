import test from 'node:test'
import assert from 'node:assert/strict'
import {
    LEGACY_SECRET_FILES,
    SECRET_METADATA_KEY,
    prepareBackendSecrets,
    persistBackendSecretRequest,
    secretStoreKey,
} from './index.mjs'

test('secret migration moves plaintext key files into secure storage and deletes the legacy copies', async () => {
    const secure = createSecureStore()
    const legacy = createLegacyFiles({
        [LEGACY_SECRET_FILES.autobaseKey]: 'A'.repeat(64),
        [LEGACY_SECRET_FILES.encryptionKey]: 'b'.repeat(64),
        [LEGACY_SECRET_FILES.ownerAuthorityKey]: 'd'.repeat(128),
        [LEGACY_SECRET_FILES.epochKey]: 'e'.repeat(64),
        [LEGACY_SECRET_FILES.epochEncryptionKey]: 'f'.repeat(64),
        [LEGACY_SECRET_FILES.localWriterKey]: 'c'.repeat(64),
        [LEGACY_SECRET_FILES.pairingInvite]: '{"id":"legacy-invite"}',
    })
    const metadata = createMetadataStore()

    const prepared = await prepareBackendSecrets({
        secureStore: secure.adapter,
        legacyFiles: legacy.adapter,
        metadataStore: metadata.adapter,
    })

    assert.equal(prepared.mode, 'secure-store')
    assert.deepEqual(prepared.backendPayload.secrets, {
        autobaseKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
        ownerAuthorityKey: 'd'.repeat(128),
        epochKey: 'e'.repeat(64),
        epochEncryptionKey: 'f'.repeat(64),
    })
    assert.equal(secure.values.get(secretStoreKey('autobaseKey')), 'a'.repeat(64))
    assert.equal(secure.values.get(secretStoreKey('encryptionKey')), 'b'.repeat(64))
    assert.equal(secure.values.get(secretStoreKey('ownerAuthorityKey')), 'd'.repeat(128))
    assert.equal(secure.values.get(secretStoreKey('epochKey')), 'e'.repeat(64))
    assert.equal(secure.values.get(secretStoreKey('epochEncryptionKey')), 'f'.repeat(64))
    // The writer key and invite are never stored in the keychain — only their
    // plaintext is cleaned up (invites must not be persisted, H3).
    assert.equal(secure.values.has(secretStoreKey('localWriterKey')), false)
    assert.equal(secure.values.has(secretStoreKey('pairingInvite')), false)
    assert.deepEqual(new Set(legacy.deleted), new Set(Object.values(LEGACY_SECRET_FILES)))

    const metadataRecord = JSON.parse(metadata.values.get(SECRET_METADATA_KEY))
    assert.equal(metadataRecord.mode, 'secure-store')
    assert.equal(metadataRecord.fingerprints.autobaseKey.startsWith('fnv1a32:'), true)
    assert.equal(JSON.stringify(metadataRecord).includes('a'.repeat(64)), false)
})

test('secret migration is idempotent and re-readable from secure storage', async () => {
    const secure = createSecureStore()
    const legacy = createLegacyFiles({
        [LEGACY_SECRET_FILES.autobaseKey]: 'a'.repeat(64),
        [LEGACY_SECRET_FILES.encryptionKey]: 'b'.repeat(64),
        [LEGACY_SECRET_FILES.ownerAuthorityKey]: 'd'.repeat(128),
        [LEGACY_SECRET_FILES.epochKey]: 'e'.repeat(64),
        [LEGACY_SECRET_FILES.epochEncryptionKey]: 'f'.repeat(64),
    })

    await prepareBackendSecrets({
        secureStore: secure.adapter,
        legacyFiles: legacy.adapter,
    })

    const second = await prepareBackendSecrets({
        secureStore: secure.adapter,
        legacyFiles: legacy.adapter,
    })

    assert.deepEqual(second.backendPayload.secrets, {
        autobaseKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
        ownerAuthorityKey: 'd'.repeat(128),
        epochKey: 'e'.repeat(64),
        epochEncryptionKey: 'f'.repeat(64),
    })
    assert.equal(legacy.reads.length >= 4, true)
    assert.deepEqual(legacy.remaining(), {})
})

test('secure-storage outage keeps plaintext files and boots through recovery payload', async () => {
    const secure = createSecureStore({ available: false })
    const legacy = createLegacyFiles({
        [LEGACY_SECRET_FILES.autobaseKey]: 'a'.repeat(64),
        [LEGACY_SECRET_FILES.encryptionKey]: 'b'.repeat(64),
        [LEGACY_SECRET_FILES.ownerAuthorityKey]: 'd'.repeat(128),
        [LEGACY_SECRET_FILES.epochKey]: 'e'.repeat(64),
        [LEGACY_SECRET_FILES.epochEncryptionKey]: 'f'.repeat(64),
    })

    const prepared = await prepareBackendSecrets({
        secureStore: secure.adapter,
        legacyFiles: legacy.adapter,
    })

    assert.equal(prepared.mode, 'plaintext-recovery')
    assert.deepEqual(prepared.backendPayload.secrets, {
        autobaseKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
        ownerAuthorityKey: 'd'.repeat(128),
        epochKey: 'e'.repeat(64),
        epochEncryptionKey: 'f'.repeat(64),
    })
    assert.deepEqual(legacy.deleted, [])
    assert.deepEqual(legacy.remaining(), {
        [LEGACY_SECRET_FILES.autobaseKey]: 'a'.repeat(64),
        [LEGACY_SECRET_FILES.encryptionKey]: 'b'.repeat(64),
        [LEGACY_SECRET_FILES.ownerAuthorityKey]: 'd'.repeat(128),
        [LEGACY_SECRET_FILES.epochKey]: 'e'.repeat(64),
        [LEGACY_SECRET_FILES.epochEncryptionKey]: 'f'.repeat(64),
    })
})

test('legacy writer-key and invite files are removed but never stored, even without secure storage', async () => {
    const secure = createSecureStore({ available: false })
    const legacy = createLegacyFiles({
        [LEGACY_SECRET_FILES.localWriterKey]: 'c'.repeat(64),
        [LEGACY_SECRET_FILES.pairingInvite]: '{"id":"legacy-invite"}',
    })

    const prepared = await prepareBackendSecrets({
        secureStore: secure.adapter,
        legacyFiles: legacy.adapter,
    })

    // Nothing durable to boot from, and the bearer/invite material is gone.
    assert.deepEqual(prepared.backendPayload.secrets, {})
    assert.equal(secure.values.size, 0)
    assert.deepEqual(new Set(legacy.deleted), new Set([
        LEGACY_SECRET_FILES.localWriterKey,
        LEGACY_SECRET_FILES.pairingInvite,
    ]))
    assert.deepEqual(legacy.remaining(), {})
})

test('backend secret persistence writes and deletes via secure storage', async () => {
    const secure = createSecureStore()
    const metadata = createMetadataStore()

    await persistBackendSecretRequest({
        name: 'autobaseKey',
        value: 'd'.repeat(64),
    }, {
        secureStore: secure.adapter,
        metadataStore: metadata.adapter,
    })

    assert.equal(secure.values.get(secretStoreKey('autobaseKey')), 'd'.repeat(64))
    assert.equal(JSON.parse(metadata.values.get(SECRET_METADATA_KEY)).mode, 'secure-store')

    await persistBackendSecretRequest({
        op: 'delete',
        name: 'autobaseKey',
    }, {
        secureStore: secure.adapter,
        metadataStore: metadata.adapter,
    })

    assert.equal(secure.values.has(secretStoreKey('autobaseKey')), false)
})

test('backend secret persistence falls back to session memory when secure storage is unavailable', async () => {
    const secure = createSecureStore({ available: false })
    const memory = createMemoryStore()

    const result = await persistBackendSecretRequest({
        name: 'encryptionKey',
        value: 'e'.repeat(64),
    }, {
        secureStore: secure.adapter,
        memoryStore: memory.adapter,
    })

    assert.equal(result.mode, 'memory-recovery')
    assert.equal(memory.values.get('encryptionKey'), 'e'.repeat(64))
})

test('owner authority key is validated as 64-byte key material', async () => {
    const secure = createSecureStore()

    await persistBackendSecretRequest({
        name: 'ownerAuthorityKey',
        value: 'f'.repeat(128),
    }, {
        secureStore: secure.adapter,
    })

    assert.equal(secure.values.get(secretStoreKey('ownerAuthorityKey')), 'f'.repeat(128))

    await assert.rejects(() => persistBackendSecretRequest({
        name: 'ownerAuthorityKey',
        value: 'f'.repeat(64),
    }, {
        secureStore: secure.adapter,
    }), /Invalid secret value/)
})

test('epoch keys are validated as 32-byte key material', async () => {
    const secure = createSecureStore()

    await persistBackendSecretRequest({
        name: 'epochKey',
        value: 'a'.repeat(64),
    }, {
        secureStore: secure.adapter,
    })
    await persistBackendSecretRequest({
        name: 'epochEncryptionKey',
        value: 'b'.repeat(64),
    }, {
        secureStore: secure.adapter,
    })

    assert.equal(secure.values.get(secretStoreKey('epochKey')), 'a'.repeat(64))
    assert.equal(secure.values.get(secretStoreKey('epochEncryptionKey')), 'b'.repeat(64))

    await assert.rejects(() => persistBackendSecretRequest({
        name: 'epochKey',
        value: 'a'.repeat(128),
    }, {
        secureStore: secure.adapter,
    }), /Invalid secret value/)
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

function createLegacyFiles(initialFiles = {}) {
    const files = { ...initialFiles }
    const deleted = []
    const reads = []
    return {
        deleted,
        reads,
        remaining() {
            return { ...files }
        },
        adapter: {
            async readFile(filename) {
                reads.push(filename)
                return files[filename] ?? null
            },
            async deleteFile(filename) {
                // Mirror the real Expo adapter, which no-ops on a missing file.
                if (filename in files) {
                    deleted.push(filename)
                    delete files[filename]
                }
            },
        },
    }
}

function createMetadataStore() {
    const values = new Map()
    return {
        values,
        adapter: {
            async setItem(key, value) {
                values.set(key, value)
            },
        },
    }
}

function createMemoryStore() {
    const values = new Map()
    return {
        values,
        adapter: {
            get(name) {
                return values.get(name) ?? null
            },
            set(name, value) {
                values.set(name, value)
            },
            delete(name) {
                values.delete(name)
            },
            snapshot() {
                return Object.fromEntries(values.entries())
            },
        },
    }
}
