import test from 'node:test'
import assert from 'node:assert/strict'
import {
    LEGACY_SECRET_FILES,
    SECRET_METADATA_KEY,
    createFileSecretStore,
    emptyBackendSecretPayload,
    parseBackendSecretPayload,
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

// --- absent vs unreadable -------------------------------------------------
// A read that FAILS and a secret that was never stored produce the same empty
// `secrets`. Only readFailures separates them, and the difference decides
// whether a host may treat itself as a fresh device.

test('a first boot with nothing stored reports no read failures', async () => {
    const prepared = await prepareBackendSecrets({ secureStore: createSecureStore().adapter })

    assert.deepEqual(prepared.backendPayload.secrets, {})
    assert.deepEqual(prepared.readFailures, [])
    assert.deepEqual(prepared.backendPayload.readFailures, [])
})

test('a keychain read that throws is reported as a failure, not as an absent secret', async () => {
    const secure = createSecureStore({ failReadsFor: [secretStoreKey('autobaseKey')] })
    const prepared = await prepareBackendSecrets({ secureStore: secure.adapter })

    assert.deepEqual(prepared.readFailures, ['autobaseKey'])
    assert.deepEqual(prepared.backendPayload.readFailures, ['autobaseKey'])
    assert.equal(prepared.backendPayload.secrets.autobaseKey, undefined)
    assert.ok(prepared.warnings.some((w) => w.includes('autobaseKey')))
})

test('an availability check that throws is a read failure, not an unavailable store', async () => {
    const secure = createSecureStore({ failAvailability: true })
    const prepared = await prepareBackendSecrets({ secureStore: secure.adapter })

    assert.equal(prepared.secureStorageAvailable, false)
    assert.deepEqual(prepared.readFailures, ['secure-storage-availability'])
})

test('a legacy read failure counts only when the legacy files ARE the identity', async () => {
    const withSecure = await prepareBackendSecrets({
        secureStore: createSecureStore().adapter,
        legacyFiles: createLegacyFiles({}, { failReadsFor: [LEGACY_SECRET_FILES.autobaseKey] }).adapter,
    })
    // Secure storage works, so a legacy file is only a migration input.
    assert.deepEqual(withSecure.readFailures, [])

    const withoutSecure = await prepareBackendSecrets({
        secureStore: createSecureStore({ available: false }).adapter,
        legacyFiles: createLegacyFiles({}, { failReadsFor: [LEGACY_SECRET_FILES.autobaseKey] }).adapter,
    })
    assert.deepEqual(withoutSecure.readFailures, ['autobaseKey'])
})

test('the boot payload carries read failures across the host/backend boundary', () => {
    const parsed = parseBackendSecretPayload(JSON.stringify({
        version: 1,
        mode: 'secure-store',
        secrets: {},
        readFailures: ['autobaseKey', 42],
    }))

    assert.deepEqual(parsed.readFailures, ['autobaseKey'])
    assert.deepEqual(emptyBackendSecretPayload().readFailures, [])
    assert.deepEqual(parseBackendSecretPayload(null).readFailures, [])
})

// --- file secret store ----------------------------------------------------

test('a missing secret file reads as an empty device (the real first boot)', async () => {
    const store = createFileSecretStore({ fs: createMemoryFs(), path: '/data/secrets.json' })
    assert.equal(await store.getItem('listam.secret.v1.autobaseKey'), null)
})

test('an unreadable secret file throws instead of reading as an empty device', async () => {
    for (const corrupt of ['{"listam.secret.v1.autobaseKey":"aaa', 'null', '[]', '']) {
        const fs = createMemoryFs({ '/data/secrets.json': corrupt })
        const store = createFileSecretStore({ fs, path: '/data/secrets.json' })
        await assert.rejects(() => store.getItem('listam.secret.v1.autobaseKey'), {
            code: 'SECRET_STORE_UNREADABLE',
        })
    }
})

test('a write to an unreadable secret file refuses instead of clobbering the other keys', async () => {
    const fs = createMemoryFs({ '/data/secrets.json': '{"listam.secret.v1.autobaseKey":"aaa' })
    const store = createFileSecretStore({ fs, path: '/data/secrets.json' })

    await assert.rejects(() => store.setItem('listam.secret.v1.epochKey', 'b'.repeat(64)), {
        code: 'SECRET_STORE_UNREADABLE',
    })
    await assert.rejects(() => store.deleteItem('listam.secret.v1.epochKey'), {
        code: 'SECRET_STORE_UNREADABLE',
    })
    // The damaged file is still there to be recovered by hand, not overwritten
    // with a single-key document.
    assert.equal(fs.files.get('/data/secrets.json'), '{"listam.secret.v1.autobaseKey":"aaa')
})

test('secret writes land atomically so a torn write cannot erase every key', async () => {
    const fs = createMemoryFs()
    const store = createFileSecretStore({ fs, path: '/data/secrets.json' })

    await store.setItem('listam.secret.v1.autobaseKey', 'a'.repeat(64))
    assert.deepEqual(fs.writes, ['/data/secrets.json.tmp'])
    assert.deepEqual(fs.renames, [['/data/secrets.json.tmp', '/data/secrets.json']])
    assert.equal(await store.getItem('listam.secret.v1.autobaseKey'), 'a'.repeat(64))

    await store.setItem('listam.secret.v1.epochKey', 'b'.repeat(64))
    assert.equal(await store.getItem('listam.secret.v1.autobaseKey'), 'a'.repeat(64))
    assert.equal(fs.modes.at(-1), 0o600)
})

function createMemoryFs(initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles))
    const writes = []
    const renames = []
    const modes = []
    return {
        files,
        writes,
        renames,
        modes,
        readFileSync(path) {
            if (!files.has(path)) {
                const err = new Error(`ENOENT: no such file, open '${path}'`)
                err.code = 'ENOENT'
                throw err
            }
            return files.get(path)
        },
        writeFileSync(path, data, options) {
            writes.push(path)
            modes.push(options?.mode)
            files.set(path, data)
        },
        renameSync(from, to) {
            renames.push([from, to])
            files.set(to, files.get(from))
            files.delete(from)
        },
    }
}

function createSecureStore(options = {}) {
    const values = new Map(Object.entries(options.values ?? {}))
    const failReads = new Set(options.failReadsFor ?? [])
    return {
        values,
        adapter: {
            async isAvailable() {
                if (options.failAvailability) throw new Error('keychain unavailable')
                return options.available ?? true
            },
            async getItem(key) {
                if (failReads.has(key)) throw new Error(`read failed for ${key}`)
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

function createLegacyFiles(initialFiles = {}, options = {}) {
    const files = { ...initialFiles }
    const deleted = []
    const reads = []
    const failReads = new Set(options.failReadsFor ?? [])
    return {
        deleted,
        reads,
        remaining() {
            return { ...files }
        },
        adapter: {
            async readFile(filename) {
                reads.push(filename)
                if (failReads.has(filename)) throw new Error(`read failed for ${filename}`)
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
