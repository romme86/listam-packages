import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createEpochEncryptionKeyPair,
    createEpochGrants,
    decryptEpochGrantForWriter,
    generateEpochKey,
    reconcileLegacyEpochEncryptionKeyPair,
} from './key-epochs.mjs'
import { encryptionKeyPair } from 'hypercore-crypto'

const WRITER_KEY = '42'.repeat(32)

test('persisted epoch encryption secret restores the same X25519 identity', () => {
    const original = createEpochEncryptionKeyPair()
    const restored = createEpochEncryptionKeyPair(original.secretKey)

    assert.deepEqual(restored.secretKey, original.secretKey)
    assert.deepEqual(restored.publicKey, original.publicKey)
})

test('a grant sealed before restart decrypts with the restored epoch identity', () => {
    const original = createEpochEncryptionKeyPair()
    const restored = createEpochEncryptionKeyPair(original.secretKey)
    const epochKey = generateEpochKey()
    const grants = createEpochGrants({
        epochKey,
        recipients: [{ writerKey: WRITER_KEY, epochPublicKey: original.publicKey }],
    })

    assert.deepEqual(
        decryptEpochGrantForWriter(grants, WRITER_KEY, restored),
        epochKey,
    )
})

test('membership-verified migration preserves the legacy restart identity', () => {
    const original = createEpochEncryptionKeyPair()
    const legacyRestartIdentity = encryptionKeyPair(original.secretKey)
    const correctlyRestored = createEpochEncryptionKeyPair(original.secretKey)

    const migration = reconcileLegacyEpochEncryptionKeyPair(
        correctlyRestored,
        legacyRestartIdentity.publicKey,
    )

    assert.equal(migration.migrated, true)
    assert.equal(migration.matched, true)
    assert.deepEqual(migration.keyPair.publicKey, legacyRestartIdentity.publicKey)
    assert.deepEqual(
        createEpochEncryptionKeyPair(migration.keyPair.secretKey).publicKey,
        legacyRestartIdentity.publicKey,
    )
})

test('legacy migration refuses an identity not signed into membership', () => {
    const original = createEpochEncryptionKeyPair()
    const stranger = createEpochEncryptionKeyPair()

    const migration = reconcileLegacyEpochEncryptionKeyPair(original, stranger.publicKey)

    assert.equal(migration.migrated, false)
    assert.equal(migration.matched, false)
    assert.equal(migration.reason, 'membership-key-mismatch')
    assert.equal(migration.keyPair, original)
})
