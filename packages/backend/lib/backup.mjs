// Backend orchestration for the encrypted backup / restore feature. The
// frontends only prompt for a password and read/write the file; everything that
// touches data, secrets, or crypto happens here.
import b4a from 'b4a'
import { encryptBackup, decryptBackup } from './backup-crypto.mjs'
import {
    buildDataSnapshot,
    parseDataSnapshot,
    snapshotItemsToOps,
    buildSeedPayload,
    parseSeedPayload,
    missingRequiredSeeds,
} from './backup-payload.mjs'
import { rebuildAllItems, enqueueWrite, prepareListAppendOperation } from './item.mjs'
import {
    saveAutobaseKey,
    saveEncryptionKey,
    saveOwnerAuthorityKey,
    saveEpochKey,
    saveEpochEncryptionKey,
} from './key.mjs'
import { initAutobase } from './network.mjs'
import { createOwnerAuthorityKeyPair, ownerAuthoritySecretKeyHex, canCreateMembershipInvite } from './membership.mjs'
import { createEpochEncryptionKeyPair, epochSecretKeyHex } from './key-epochs.mjs'
import { createBoardConfigRecord, nextBoardConfigSequence } from './board-config.mjs'
import { normalizeBoardConfig } from './board.mjs'
import { logger } from './logger.mjs'
import {
    autobase,
    baseKey,
    encryptionKey,
    ownerAuthorityKeyPair,
    epochKey,
    epochEncryptionKeyPair,
    membershipState,
    boardConfigState,
    setBaseKey,
    setEncryptionKey,
    setOwnerAuthorityKeyPair,
    setEpochKey,
    setEpochEncryptionKeyPair,
} from './state.mjs'

// ---- Export ---------------------------------------------------------------

export async function exportDataBackup(password) {
    const items = await rebuildAllItems()
    const snapshot = buildDataSnapshot({ items, boardConfig: boardConfigState?.config || null })
    return encryptBackup(snapshot, password, 'data')
}

// Read this instance's live secret identity from state. Buffers are hex-encoded
// to the exact widths @listam/secrets expects.
export function readInstanceSeedSecrets() {
    const secrets = {}
    if (baseKey) secrets.autobaseKey = b4a.toString(baseKey, 'hex')
    if (encryptionKey) secrets.encryptionKey = b4a.toString(encryptionKey, 'hex')
    const owner = ownerAuthoritySecretKeyHex(ownerAuthorityKeyPair)
    if (owner) secrets.ownerAuthorityKey = owner
    if (epochKey) secrets.epochKey = b4a.toString(epochKey, 'hex')
    const epochEnc = epochSecretKeyHex(epochEncryptionKeyPair)
    if (epochEnc) secrets.epochEncryptionKey = epochEnc
    return secrets
}

export async function exportSeedBackup(password) {
    const secrets = readInstanceSeedSecrets()
    const missing = missingRequiredSeeds(secrets)
    if (missing.length) {
        // A guest device (joined via invite) holds no owner authority, so there
        // is no full instance identity to export. Refuse rather than emit a
        // partial, unrestorable seed.
        const error = new Error('seed-incomplete')
        error.missing = missing
        throw error
    }
    return encryptBackup(buildSeedPayload(secrets), password, 'seed')
}

// ---- Import ---------------------------------------------------------------

// Decrypt a saved envelope and apply it. Branches on the file's `kind`:
// 'data' merges the content snapshot (LWW), 'seed' restores the identity.
export async function importBackup(password, fileText) {
    const decoded = decryptBackup(fileText, password)
    if (decoded.kind === 'data') return importDataSnapshot(decoded.payload)
    if (decoded.kind === 'seed') return importSeedSnapshot(decoded.payload)
    throw new Error('Unrecognized backup kind')
}

async function importDataSnapshot(payload) {
    const { items, boardConfig } = parseDataSnapshot(payload)
    const ops = snapshotItemsToOps(items)
    const applied = { items: 0, boardConfig: false, boardConfigSkipped: false }
    let reason = null

    // One critical section for the whole batch: no epoch rotation can interleave
    // between items, so every op is tagged with one consistent current epoch.
    await enqueueWrite(async () => {
        if (!autobase || autobase.closing) { reason = 'not-ready'; return }
        if (!autobase.writable) { reason = 'not-writable'; return }

        for (const op of ops) {
            try {
                await autobase.append(prepareListAppendOperation(op))
                applied.items++
            } catch (e) {
                logger.log('[ERROR] import: failed to append item op:', e?.message ?? e)
            }
        }

        if (boardConfig) {
            // Board config is owner-signed; a record from a non-owner is rejected
            // by every peer's apply(). Apply it only when this device is the
            // board owner, otherwise skip and let the UI explain.
            if (canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
                try {
                    const merged = normalizeBoardConfig({
                        ...(boardConfigState?.config || normalizeBoardConfig(null)),
                        ...boardConfig,
                    })
                    const record = createBoardConfigRecord({
                        ownerAuthorityKeyPair,
                        baseKey: autobase.key.toString('hex'),
                        config: merged,
                        sequence: nextBoardConfigSequence(boardConfigState),
                        createdAt: Date.now(),
                    })
                    await autobase.append(record)
                    applied.boardConfig = true
                } catch (e) {
                    logger.log('[ERROR] import: failed to apply board config:', e?.message ?? e)
                }
            } else {
                applied.boardConfigSkipped = true
            }
        }

        try { await autobase.update() } catch { /* best effort */ }
    })

    return { kind: 'data', applied, reason }
}

async function importSeedSnapshot(payload) {
    const secrets = parseSeedPayload(payload)
    const missing = missingRequiredSeeds(secrets)
    if (missing.length) {
        const error = new Error('seed-incomplete')
        error.missing = missing
        throw error
    }

    const restoredBaseKey = b4a.from(secrets.autobaseKey, 'hex')
    const restoredEncryptionKey = b4a.from(secrets.encryptionKey, 'hex')
    const restoredOwner = createOwnerAuthorityKeyPair(b4a.from(secrets.ownerAuthorityKey, 'hex'))
    if (!restoredOwner) throw new Error('seed-invalid')
    const restoredEpochKey = secrets.epochKey ? b4a.from(secrets.epochKey, 'hex') : null
    const restoredEpochEnc = secrets.epochEncryptionKey
        ? createEpochEncryptionKeyPair(b4a.from(secrets.epochEncryptionKey, 'hex'))
        : null

    // Swap the in-memory identity, then make it durable, then rebuild the base
    // in-process on the restored key (this is the proven join-via-invite
    // re-init path; data re-replicates from peers once the base is back up).
    setBaseKey(restoredBaseKey)
    setEncryptionKey(restoredEncryptionKey)
    setOwnerAuthorityKeyPair(restoredOwner)
    setEpochKey(restoredEpochKey)
    setEpochEncryptionKeyPair(restoredEpochEnc)

    await saveAutobaseKey(restoredBaseKey)
    await saveEncryptionKey(restoredEncryptionKey)
    await saveOwnerAuthorityKey(restoredOwner.secretKey)
    if (restoredEpochKey) await saveEpochKey(restoredEpochKey)
    if (restoredEpochEnc) await saveEpochEncryptionKey(restoredEpochEnc.secretKey)

    await initAutobase(restoredBaseKey, { allowOwnerMigration: false })

    return { kind: 'seed', restored: true }
}
