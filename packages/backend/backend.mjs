import {
    RPC_UPDATE,
    RPC_ADD,
    RPC_DELETE,
    RPC_GET_KEY,
    RPC_JOIN_KEY,
    RPC_ADD_FROM_BACKEND,
    RPC_UPDATE_FROM_BACKEND,
    RPC_DELETE_FROM_BACKEND,
    RPC_MESSAGE,
    SYNC_LIST,
    RPC_REQUEST_SYNC,
    RPC_CREATE_INVITE,
    RPC_REMOVE_MEMBER,
    RPC_GET_MEMBERS,
    RPC_GET_OWNER_RECOVERY_CODE,
    RPC_RECOVER_OWNER,
    RPC_RECOVER_STORAGE,
    RPC_CONTROL_PAIR,
    RPC_CONTROL_COMMAND,
    RPC_CONTROL_LIST
} from '@listam/protocol'
import b4a from 'b4a'
import {syncListToFrontend, validateItem, addItem, updateItem, deleteItem} from './lib/item.mjs'
import {
    applyOperationToList,
    createListViewEntry,
    normalizeListOperation,
} from './lib/list-reducer.mjs'
import {loadAutobaseKey, saveAutobaseKey, loadEncryptionKey, saveEncryptionKey, loadOwnerAuthorityKey, saveOwnerAuthorityKey, deleteLegacyKeyFile, deleteLegacyInviteFile, loadEpochKey, saveEpochKey, deleteEpochKey, loadEpochEncryptionKey, saveEpochEncryptionKey} from "./lib/key.mjs"
import {initAutobase, joinViaInvite, createInvite, removeMemberAndRotateEpoch, broadcastMembershipRoster, sendOwnerRecoveryCodeToFrontend, recoverOwnerAuthority, performStorageRecovery} from "./lib/network.mjs"
import { normalizeRecoveryPolicy } from './lib/recovery.mjs'
import { createStorageLease } from './lib/storage-lease.mjs'
import { parseBootSecretPayload, getBootSecretBuffer, persistBackendSecret } from './lib/secrets.mjs'
import { createOwnerControlClient } from './lib/owner-control-client.mjs'
import { isMembershipRecord, reduceMembershipLog, reduceMembershipOperation } from './lib/membership.mjs'
import { createViewCheckpoint } from './lib/view-checkpoint.mjs'
import { removeWriterAtConsensus } from './lib/writer-removal.mjs'
import { decryptEncryptedListOperation, decryptEpochGrantForWriter, epochKeyHashHex, isEncryptedListOperation } from './lib/key-epochs.mjs'
import {
    autobase,
    store,
    swarm,
    discovery,
    pairing,
    rpc,
    currentList,
    baseKey,
    epochKey,
    epochEncryptionKeyPair,
    membershipState,
    setRpc,
    setCurrentList,
    setBaseKey,
    setEncryptionKey,
    setMembershipState,
    setOwnerAuthorityKeyPair,
    setEpochKey,
    setEpochEncryptionKeyPair
} from "./lib/state.mjs"
import { logger } from './lib/logger.mjs'
import { setBackendFs } from './lib/platform-fs.mjs'

export let storagePath = './data'
export let peerKeysString = ''
export let keyFilePath = './autobase-key.txt'
export let encKeyFilePath = './encryption-key.txt'
export let ownerAuthorityKeyFilePath = './owner-authority-key.txt'
export let legacyInviteFilePath = './invite.json'
export let recoveryPolicy = 'refuse-destructive'
// Optional private DHT bootstrap nodes (the shared test harness requirement):
// when set, every Hyperswarm this backend creates joins the private testnet
// instead of the public DHT, so cross-instance tests run hermetically.
export let swarmBootstrap = null

// Lazily-created owner-control client (Phase 14/15): the worklet's hyperdht
// client for pairing with and commanding the user's headless instances.
let ownerControlClient = null
let bootSecretsForControl = null

let localWriterKeyFilePath = './local-writer-key.txt'
let lockPath = './lista.lock'
let storageLease = null
let platformFs = null
let shutdownStarted = false

export function createBackendPaths(platform, argv = platform.argv ?? []) {
    const join = platform.join
    const argv0 = typeof argv?.[0] === 'string' ? argv[0] : ''
    let baseDir = ''

    if (argv0) {
        try {
            baseDir = argv0.startsWith('file://') ? platform.fileURLToPath(argv0) : argv0
        } catch {
            baseDir = ''
        }
    }

    // Storage-root isolation: each app role gets its own storage root and its
    // own lease, so desktop + headless on one machine never contend for (or
    // corrupt) the same Corestore. The default namespace keeps the historical
    // mobile paths. Legacy key-file names stay un-namespaced — they are
    // migration inputs from the single-app era.
    const namespace = normalizeStorageNamespace(platform.storageNamespace)
    const rootName = namespace ? `lista-${namespace}` : 'lista'

    return {
        baseDir,
        storageNamespace: namespace,
        storagePath: baseDir ? join(baseDir, rootName) : `./data${namespace ? `-${namespace}` : ''}`,
        peerKeysString: argv?.[1] || '',
        baseKeyHex: argv?.[2] || '',
        bootSecretPayload: argv?.[3] || '',
        keyFilePath: baseDir ? join(baseDir, 'lista-autobase-key.txt') : './autobase-key.txt',
        localWriterKeyFilePath: baseDir ? join(baseDir, 'lista-local-writer-key.txt') : './local-writer-key.txt',
        encKeyFilePath: baseDir ? join(baseDir, 'lista-encryption-key.txt') : './encryption-key.txt',
        ownerAuthorityKeyFilePath: baseDir ? join(baseDir, 'lista-owner-authority-key.txt') : './owner-authority-key.txt',
        legacyInviteFilePath: baseDir ? join(baseDir, 'lista-invite.json') : './invite.json',
        lockPath: baseDir ? join(baseDir, `${rootName}.lock`) : `./${rootName}.lock`,
    }
}

function normalizeStorageNamespace(value) {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32)
}

export async function startBackend(platform) {
    if (!platform?.fs || typeof platform.createRpc !== 'function') {
        throw new Error('A backend platform with fs and createRpc is required')
    }

    const instanceId = Math.random().toString(36).slice(2, 8)
    logger.log('[INFO] BACKEND INSTANCE:', instanceId)
    shutdownStarted = false

    const paths = createBackendPaths(platform)
    storagePath = paths.storagePath
    peerKeysString = paths.peerKeysString
    keyFilePath = paths.keyFilePath
    localWriterKeyFilePath = paths.localWriterKeyFilePath
    encKeyFilePath = paths.encKeyFilePath
    ownerAuthorityKeyFilePath = paths.ownerAuthorityKeyFilePath
    legacyInviteFilePath = paths.legacyInviteFilePath
    lockPath = paths.lockPath
    recoveryPolicy = normalizeRecoveryPolicy(platform.recoveryPolicy)
    swarmBootstrap = Array.isArray(platform.bootstrap) && platform.bootstrap.length > 0
        ? platform.bootstrap
        : null
    platformFs = platform.fs
    setBackendFs(platformFs)

    // Single-writer lease over this storage root. Unlike the previous 'wx'
    // lock file, a lease left behind by a crash expires and is recovered
    // instead of blocking every later start until it is deleted by hand.
    // The module-level storageLease is only replaced after acquisition
    // succeeds, so a refused second start cannot clobber the running
    // instance's lease handle.
    const lease = createStorageLease({
        fs: platformFs,
        path: lockPath,
        instanceId,
        role: paths.storageNamespace || 'default',
        ttlMs: platform.leaseTtlMs,
    })
    const leaseResult = lease.acquire()
    if (!leaseResult.ok) {
        const owner = leaseResult.owner
        logger.log(`[ERROR] [${instanceId}] Another backend instance holds the storage lease:`, lockPath, owner ? { owner: owner.instanceId, role: owner.role } : {})
        throw new Error('Storage lease is held by another running instance')
    }
    if (leaseResult.recoveredStale) {
        logger.log(`[AUDIT] [${instanceId}] Recovered a stale storage lease (previous instance did not shut down cleanly)`)
    }
    storageLease = lease
    storageLease.startHeartbeat(() => {
        logger.log(`[ERROR] [${instanceId}] Storage lease was lost to another instance; this backend no longer owns the storage root`)
    })
    logger.log(`[INFO] [${instanceId}] Acquired storage lease:`, lockPath)

    const bootSecrets = parseBootSecretPayload(paths.bootSecretPayload)
    bootSecretsForControl = bootSecrets

    // Optional Autobase key from argv (initial base) or loaded from file.
    if (paths.baseKeyHex) {
        try {
            setBaseKey(Buffer.from(paths.baseKeyHex.trim(), 'hex'))
            logger.log('[INFO] Using existing Autobase key from argv[2]')
        } catch (err) {
            logger.log('[ERROR] Invalid base key hex, creating new base instead:', err.message)
            setBaseKey(null)
        }
    }

    // If no key from argv, load from the adapter boot payload, falling back to the
    // backend's own legacy plaintext file (authoritative path) so an existing base
    // is never lost if the pre-boot migration could not reach the file.
    let autobaseKeyFromLegacyFile = false
    let encryptionKeyFromLegacyFile = false
    let ownerAuthorityKeyFromLegacyFile = false
    let loadedEncryptionKey = null
    let loadedOwnerAuthorityKeyPair = null
    if (!baseKey) {
        const loaded = loadAutobaseKey(bootSecrets, keyFilePath)
        setBaseKey(loaded.key)
        autobaseKeyFromLegacyFile = loaded.source === 'legacy-file'
    }

    // Load encryption key if we have a base key (for restart persistence).
    if (baseKey) {
        const loaded = loadEncryptionKey(bootSecrets, encKeyFilePath)
        if (loaded.key) {
            setEncryptionKey(loaded.key)
            loadedEncryptionKey = loaded.key
            encryptionKeyFromLegacyFile = loaded.source === 'legacy-file'
        }
    }

    const loadedOwnerAuthority = loadOwnerAuthorityKey(bootSecrets, ownerAuthorityKeyFilePath)
    if (loadedOwnerAuthority.keyPair) {
        setOwnerAuthorityKeyPair(loadedOwnerAuthority.keyPair)
        loadedOwnerAuthorityKeyPair = loadedOwnerAuthority.keyPair
        ownerAuthorityKeyFromLegacyFile = loadedOwnerAuthority.source === 'legacy-file'
    }

    const loadedEpoch = loadEpochKey(bootSecrets)
    if (loadedEpoch.key) {
        setEpochKey(loadedEpoch.key)
    }

    const loadedEpochEncryption = loadEpochEncryptionKey(bootSecrets)
    if (loadedEpochEncryption.keyPair) {
        setEpochEncryptionKeyPair(loadedEpochEncryption.keyPair)
    }

    const rpcGenerated = platform.createRpc(handleFrontendRequest)
    setRpc(rpcGenerated)

    await reconcileLegacyKeyFiles({
        autobaseKeyFromLegacyFile,
        encryptionKeyFromLegacyFile,
        ownerAuthorityKeyFromLegacyFile,
        loadedEncryptionKey,
        loadedOwnerAuthorityKeyPair,
    })

    await initAutobase(baseKey).then(() => {
        logger.log('[INFO] Autobase ready 123')
    }).catch((err) => {
        logger.log('[ERROR] initAutobase failed at startup:', err)
        throw err
    })

    const disposeTeardown = platform.onTeardown?.(shutdownBackend)
    return { paths, rpc: rpcGenerated, shutdown: shutdownBackend, disposeTeardown }
}

async function handleFrontendRequest(req, error) {
    logger.log('[INFO] Got a request from react', req)
    if (error) {
        logger.log('[ERROR] Got an error from react', error)
    }
    try {
        switch (req.command) {
            case RPC_ADD: {
                const payload = JSON.parse(b4a.toString(req.data))
                if (typeof payload === 'string') {
                    await addItem(payload)
                } else {
                    await addItem(payload?.text, payload?.listId, payload?.listType)
                }
                break
            }
            case RPC_UPDATE: {
                const data = JSON.parse(req.data.toString())
                await updateItem(data.item)
                break
            }
            case RPC_DELETE: {
                const data = JSON.parse(req.data.toString())
                await deleteItem(data.item)
                break
            }
            case RPC_GET_KEY: {
                logger.log('[INFO] Command RPC_GET_KEY')
                if (!autobase) {
                    logger.log('[WARNING] RPC_GET_KEY requested before Autobase is ready')
                    break
                }
                const z32Invite = createInvite()
                const keyReq = rpc.request(RPC_GET_KEY)
                keyReq.send(z32Invite || '')
                break
            }
            case RPC_JOIN_KEY: {
                logger.log('[INFO] Command RPC_JOIN_KEY')
                const data = JSON.parse(req.data.toString())
                logger.log('[INFO] Joining via invite from RPC')
                await joinViaInvite(data.key)
                break
            }
            case RPC_CREATE_INVITE: {
                logger.log('[INFO] Command RPC_CREATE_INVITE')
                const z32Invite = createInvite()
                if (rpc) {
                    const keyReq = rpc.request(RPC_GET_KEY)
                    keyReq.send(z32Invite || '')
                }
                break
            }
            case RPC_REMOVE_MEMBER: {
                logger.log('[INFO] Command RPC_REMOVE_MEMBER')
                const data = JSON.parse(req.data.toString())
                await removeMemberAndRotateEpoch(data.writerKey)
                break
            }
            case RPC_GET_MEMBERS: {
                logger.log('[INFO] Command RPC_GET_MEMBERS')
                broadcastMembershipRoster()
                break
            }
            case RPC_GET_OWNER_RECOVERY_CODE: {
                logger.log('[INFO] Command RPC_GET_OWNER_RECOVERY_CODE')
                sendOwnerRecoveryCodeToFrontend()
                break
            }
            case RPC_RECOVER_OWNER: {
                logger.log('[INFO] Command RPC_RECOVER_OWNER')
                const data = JSON.parse(req.data.toString())
                await recoverOwnerAuthority(data.code)
                break
            }
            case RPC_RECOVER_STORAGE: {
                logger.log('[INFO] Command RPC_RECOVER_STORAGE')
                const data = JSON.parse(req.data.toString())
                await performStorageRecovery(data.action)
                break
            }
            case RPC_REQUEST_SYNC: {
                logger.log('[INFO] Command RPC_REQUEST_SYNC - frontend requesting current list')
                syncListToFrontend()
                break
            }
            case RPC_CONTROL_LIST: {
                logger.log('[INFO] Command RPC_CONTROL_LIST')
                const data = parseRpcJson(req.data)
                const client = ensureOwnerControlClient()
                if (data?.servers) client.setServers(data.servers)
                notifyFrontend({ type: 'owner-control-servers', servers: client.listServers(), deviceId: await client.deviceId() })
                break
            }
            case RPC_CONTROL_PAIR: {
                logger.log('[INFO] Command RPC_CONTROL_PAIR')
                const data = parseRpcJson(req.data)
                const result = await ensureOwnerControlClient().pair(data?.code, data?.name)
                notifyFrontend({ type: 'owner-control-paired', ok: result?.ok === true, reason: result?.reason, servers: result?.servers })
                break
            }
            case RPC_CONTROL_COMMAND: {
                logger.log('[INFO] Command RPC_CONTROL_COMMAND')
                const data = parseRpcJson(req.data)
                const result = await ensureOwnerControlClient().command(data?.serverPublicKeyHex, data?.command, data?.payload)
                notifyFrontend({ type: 'owner-control-result', command: data?.command, serverPublicKeyHex: data?.serverPublicKeyHex, result })
                break
            }
        }
    } catch (err) {
        logger.log('[ERROR] Error handling RPC request:', err)
    }
}

function parseRpcJson(data) {
    try {
        return JSON.parse(data.toString())
    } catch {
        return null
    }
}

// The owner-control client is created on first use so a backend that never
// touches headless devices pays no DHT/identity cost. The device seed rides
// the same secure-storage boundary as the list keys.
function ensureOwnerControlClient() {
    if (ownerControlClient) return ownerControlClient
    ownerControlClient = createOwnerControlClient({
        async loadControlSeed() {
            const buffer = getBootSecretBuffer(bootSecretsForControl, 'controlDeviceSeed')
            return buffer ? buffer.toString('hex') : null
        },
        async saveControlSeed(seedHex) {
            return persistBackendSecret('controlDeviceSeed', Buffer.from(seedHex, 'hex'))
        },
        logger,
    })
    return ownerControlClient
}

async function reconcileLegacyKeyFiles({
    autobaseKeyFromLegacyFile,
    encryptionKeyFromLegacyFile,
    ownerAuthorityKeyFromLegacyFile,
    loadedEncryptionKey,
    loadedOwnerAuthorityKeyPair,
}) {
    if (autobaseKeyFromLegacyFile && baseKey) {
        if (await saveAutobaseKey(baseKey)) {
            deleteLegacyKeyFile(keyFilePath)
            logger.log('[INFO] Migrated legacy autobase key file into secure storage')
        }
    }
    if (encryptionKeyFromLegacyFile && loadedEncryptionKey) {
        if (await saveEncryptionKey(loadedEncryptionKey)) {
            deleteLegacyKeyFile(encKeyFilePath)
            logger.log('[INFO] Migrated legacy encryption key file into secure storage')
        }
    }
    if (ownerAuthorityKeyFromLegacyFile && loadedOwnerAuthorityKeyPair?.secretKey) {
        if (await saveOwnerAuthorityKey(loadedOwnerAuthorityKeyPair.secretKey)) {
            deleteLegacyKeyFile(ownerAuthorityKeyFilePath)
            logger.log('[INFO] Migrated legacy owner authority key file into secure storage')
        }
    }
    // The local writer key is derived from the corestore (no consumer) and the
    // invite is an expiring bearer secret (H3); neither is ever re-stored.
    deleteLegacyKeyFile(localWriterKeyFilePath)
    deleteLegacyInviteFile(legacyInviteFilePath)
}

export async function shutdownBackend() {
    if (shutdownStarted) return
    shutdownStarted = true

    logger.log('[INFO] Backend shutting down...')
    if (pairing) {
        try {
            await pairing.close()
        } catch (e) {
            logger.log('[ERROR] Error closing blind pairing:', e)
        }
    }
    if (swarm) {
        swarm.removeAllListeners('connection')
        try {
            await swarm.destroy()
        } catch (e) {
            logger.log('[ERROR] Error destroying replication swarm:', e)
        }
    }
    if (autobase) {
        try {
            await autobase.close()
        } catch (e) {
            logger.log('[ERROR] Error closing autobase:', e)
        }
    }
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            logger.log('[ERROR] Error destroying discovery:', e)
        }
    }
    if(store){
        try {
            if (typeof store.flush === 'function') await store.flush()
            await store.close()
        } catch (e) {
            logger.log('[ERROR] Error closing store:', e)
        }
    }
    try {
        if (storageLease) storageLease.release()
        storageLease = null
    } catch (e) {
        logger.log('[ERROR] Error releasing storage lease:', e)
    }
    if (ownerControlClient) {
        try {
            await ownerControlClient.close()
        } catch (e) {
            logger.log('[ERROR] Error closing owner-control client:', e)
        }
        ownerControlClient = null
    }
    logger.log('[INFO] Backend shutdown complete')
}

export function open (store) {
    const view = store.get({
        name: 'test',
        valueEncoding: 'json'
    })
    logger.log('[INFO] Opening store')
    return view
}

// Send a one-off status/event message to the frontend over RPC_MESSAGE.
function notifyFrontend(payload) {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify(payload))
    } catch (e) {
        logger.log('[ERROR] Failed to notify frontend:', e)
    }
}

// Membership state must be derived from the view, not accumulated in memory
// across apply() calls: when the indexer set changes (e.g. a writer is added),
// the linearizer truncates the view and re-runs history through apply. An
// in-memory accumulator survives that truncation, so the re-processed
// membership records would be rejected as replays — and host.addWriter would
// never run on the reorged timeline, leaving a just-added member permanently
// non-writable. The truncation-aware checkpoint re-reduces from the view
// (incrementally; full re-scan only after an actual reorg).
const applyMembershipCheckpoint = createViewCheckpoint()

export function resetApplyMembershipCheckpoint() {
    applyMembershipCheckpoint.reset()
}

export async function apply (nodes, view, host) {
    if (autobase?.closing) {
        logger.log('[WARNING] Apply called while Autobase is closing; skipping.')
        return
    }
    logger.log('[INFO] Apply started')

    const { membershipRecords } = await applyMembershipCheckpoint.update(view)
    setMembershipState(reduceMembershipLog(membershipRecords, { baseKey: autobase?.key }))

    for (const { value } of nodes) {
        if (!value) continue

        if (isMembershipRecord(value)) {
            const result = reduceMembershipOperation(value, membershipState, { baseKey: autobase?.key })
            setMembershipState(result.state)
            if (!result.ok) {
                logger.log('[WARNING] Rejected membership op', { reason: result.reason })
                continue
            }

            // Persist accepted membership records into the linearized view so the
            // reduced membership state can be rebuilt after a restart. Autobase
            // does not re-run apply over already-applied history on reopen, so
            // state derived only in memory (owner key, writers, sequence
            // high-water mark) would otherwise be lost — causing sequence reuse
            // and writer-set divergence between peers. See rebuildMembershipFromPersistedOps.
            await view.append({ op: 'membership', record: value })

            if (result.effect?.epochGrants) {
                await adoptGrantedEpochKey(result)
            }

            if (result.effect?.addWriterKey) {
                try {
                    const writerKey = Buffer.from(result.effect.addWriterKey, 'hex')
                    await host.addWriter(writerKey, { indexer: true })
                    logger.log('[INFO] Added writer from owner-signed membership op')
                } catch (err) {
                    logger.log('[ERROR] Failed to add writer from membership op:', err)
                }
            }
            if (result.effect?.removeWriterKey) {
                const writerKey = Buffer.from(result.effect.removeWriterKey, 'hex')
                const outcome = await removeWriterAtConsensus({ host, writerKey, logger })
                if (outcome.removed) {
                    logger.log('[AUDIT] Removed writer from owner-signed membership op', result.effect.audit)
                } else {
                    // The epoch already rotated, so the removed member loses read
                    // access to new content even if the consensus-layer removal
                    // did not take. Surface it so the owner knows the member may
                    // still be able to append and can intervene.
                    logger.log('[AUDIT] Writer removal only partially enforced (epoch rotated, consensus removal failed)', {
                        ...result.effect.audit,
                        reason: outcome.reason,
                    })
                    notifyFrontend({ type: 'member-removal-incomplete', writerKey: result.effect.removeWriterKey, reason: outcome.reason })
                }
                if (autobase?.local?.key?.toString('hex') === result.effect.removeWriterKey) {
                    setEpochKey(null)
                    await deleteEpochKey()
                    logger.log('[AUDIT] Local writer was removed; retired local epoch key')
                }
            }

            // The writer set changed; refresh the frontend roster.
            if (result.effect?.addWriterKey || result.effect?.removeWriterKey) {
                broadcastMembershipRoster()
            }
            continue
        }

        const unwrappedOperation = unwrapListOperation(value)
        if (!unwrappedOperation) continue

        // Legacy add-writer records are intentionally no longer authoritative.
        // Phase 3 only supports revoking unused invites; true member removal
        // requires the Phase 4 re-key flow.
        if (unwrappedOperation.type === 'add-writer' && typeof unwrappedOperation.key === 'string') {
            logger.log('[WARNING] Rejected legacy add-writer op; owner-signed membership is required')
            continue
        }

        const operation = normalizeListOperation(unwrappedOperation)
        if (!operation) continue

        if (operation.type === 'add') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in add operation:', operation.value)
                continue
            }
            logger.log('[INFO] Applying add operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            setCurrentList(applyOperationToList(currentList, operation))
            const addReq = rpc.request(RPC_ADD_FROM_BACKEND)
            addReq.send(JSON.stringify(operation.value))
            continue
        }

        if (operation.type === 'delete') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in delete operation:', operation.value)
                continue
            }
            logger.log('[INFO] Applying delete operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            setCurrentList(applyOperationToList(currentList, operation))
            const deleteReq = rpc.request(RPC_DELETE_FROM_BACKEND)
            deleteReq.send(JSON.stringify(operation.value))
            continue
        }

        if (operation.type === 'update') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in update operation:', operation.value)
                continue
            }
            logger.log('[INFO] Applying update operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            setCurrentList(applyOperationToList(currentList, operation))
            const updateReq = rpc.request(RPC_UPDATE_FROM_BACKEND)
            updateReq.send(JSON.stringify(operation.value))
            continue
        }

        if (operation.type === 'list') {
            if (!Array.isArray(operation.value)) {
                logger.log('[WARNING] Invalid list operation payload, expected array:', operation.value)
                continue
            }
            logger.log('[INFO] Applying list operation for items:', operation.value)
            await view.append(createListViewEntry(operation))
            const nextList = applyOperationToList(currentList, operation)
            setCurrentList(nextList)
            const updateReq = rpc.request(SYNC_LIST)
            updateReq.send(JSON.stringify(nextList))
            continue
        }

        // All other values are appended to the view (for future use)
        await view.append(operation)
    }
}

async function adoptGrantedEpochKey(result) {
    if (!autobase?.local?.key || !epochEncryptionKeyPair) return

    const localWriterKey = autobase.local.key.toString('hex')
    const grantedEpochKey = decryptEpochGrantForWriter(
        result.effect.epochGrants,
        localWriterKey,
        epochEncryptionKeyPair,
    )
    if (!grantedEpochKey) return

    if (epochKeyHashHex(grantedEpochKey) !== result.effect.epochKeyHash) {
        logger.log('[WARNING] Ignoring epoch grant with mismatched key hash')
        return
    }

    setEpochKey(grantedEpochKey)
    await saveEpochKey(grantedEpochKey)
    logger.log('[INFO] Adopted granted epoch key', {
        epoch: result.state.currentEpoch,
        epochKeyHash: result.effect.epochKeyHash,
    })
}

function unwrapListOperation(value) {
    if (!isEncryptedListOperation(value)) return value

    if (Number(value.epoch) !== Number(membershipState?.currentEpoch)) {
        logger.log('[WARNING] Ignoring encrypted list op for inactive epoch', {
            opEpoch: value.epoch,
            currentEpoch: membershipState?.currentEpoch,
        })
        return null
    }

    const operation = decryptEncryptedListOperation(value, epochKey)
    if (!operation) {
        logger.log('[WARNING] Could not decrypt encrypted list op for current epoch')
        return null
    }
    return operation
}
