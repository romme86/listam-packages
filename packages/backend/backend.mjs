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
    RPC_CONTROL_LIST,
    RPC_SET_BOARD_CONFIG,
    RPC_GET_BOARD_CONFIG,
    RPC_EXPORT_DATA,
    RPC_EXPORT_SEED,
    RPC_IMPORT,
    RPC_MOVE,
    RPC_LIST_BACKUPS,
    RPC_RESTORE_BACKUP,
    RPC_SET_BACKUP_PASSWORD,
    RPC_SET_BACKUP_SCHEDULE,
    RPC_SHARE_LIST,
    RPC_JOIN_LIST
} from '@listam/protocol'
import b4a from 'b4a'
import {syncListToFrontend, validateItem, addItem, updateItem, deleteItem, moveItem, rebuildExtraListItems, rebuildAllItems, projectItemsToFrontend, clearWriteChain, setMutationHook} from './lib/item.mjs'
import { stopPresenceHeartbeat, writeHeartbeat, notePresenceInteraction } from './lib/presence-heartbeat.mjs'
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
import { exportDataBackup, exportSeedBackup, importBackup } from './lib/backup.mjs'
import { listAutoBackups, restoreAutoBackup, setBackupPassword, isBackupPasswordSet, startScheduledBackups, stopScheduledBackups, scheduleState, setScheduleEnabled } from './lib/auto-backup.mjs'
import { createOwnerControlClient } from './lib/owner-control-client.mjs'
import { isMembershipRecord, reduceMembershipLog, reduceMembershipOperation, canCreateMembershipInvite } from './lib/membership.mjs'
import { isBoardConfigRecord, reduceBoardConfigLog, reduceBoardConfigOperation, createBoardConfigRecord, nextBoardConfigSequence } from './lib/board-config.mjs'
import { isBoardType, validateTicketDraft, normalizeBoardConfig } from './lib/board.mjs'
import { createViewCheckpoint } from './lib/view-checkpoint.mjs'
import { isPersonalContext, createBaseContext } from './lib/base-context.mjs'
import { createBaseManager } from './lib/base-manager.mjs'
import { openSharedBase, closeSharedBase, bootstrapSharedOwner, setupSharedPairing, createSharedInvite, seedSharedBase, joinSharedBaseViaInvite, sharedDirNameForInvite, sharedListIdentity, rebuildSharedListFromView, persistSharedSecrets, autoOpenSharedBase, authorizeWriterOnSharedBase } from './lib/shared-base.mjs'
import { reduceRegistry, isRegistryItem, REG_KIND_LIST, buildListMetaItem } from './lib/list-registry.mjs'
import { planOrphanedListHeals, tombstonedFromLog } from './lib/orphan-heal.mjs'
import { DEFAULT_LIST_ID, DEFAULT_LIST_TYPE } from '@listam/domain/identity'
import { isInternalChannelItem, buildSharedCredItem, reduceSharedCreds, buildSharedJoinReqItem, reduceSharedJoinReqs } from './lib/shared-creds.mjs'
import { removeWriterAtConsensus } from './lib/writer-removal.mjs'
import { decryptEncryptedListOperation, decryptEpochGrantForWriter, epochKeyHashHex, epochPublicKeyHex, isEncryptedListOperation } from './lib/key-epochs.mjs'
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
    boardConfigState,
    ownerAuthorityKeyPair,
    setRpc,
    setCurrentList,
    setBaseKey,
    setEncryptionKey,
    setMembershipState,
    setBoardConfigState,
    setOwnerAuthorityKeyPair,
    setEpochKey,
    setEpochEncryptionKeyPair
} from "./lib/state.mjs"
import { logger } from './lib/logger.mjs'
import { setBackendFs, getBackendFs } from './lib/platform-fs.mjs'

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

// Single-list sharing (multi-base): the personal base above stays the primary;
// `baseManager` owns the SHARED single-list bases opened alongside it. The
// personal registry (list meta-items carrying `regBaseKey`) is the source of
// truth for which shared bases this device should be in — reconcileSharedBases
// diffs it against what's open. `_listIdToBaseKey` is the derived listId →
// shared-base-key index used to route a write to the right base when the UI
// did not tag the payload with an explicit baseKey.
let baseManager = null
const _listIdToBaseKey = new Map()
// Cross-device auto-join: baseKeyHex → propagated READ credentials ({encKey,
// epochKey}) for shared bases referenced by the personal registry that this
// device has not joined locally. Refreshed by reconcileSharedBases from the
// __sharedcreds__ channel; consumed by openSharedForManager to auto-open them.
const _sharedCredsByBaseKey = new Map()
let _reconcileTimer = null
// resolveWriteContext sentinel: a shared base was named but is not open, so the
// write must be refused rather than silently written to the personal base.
const WRITE_REFUSED = Symbol('write-refused')

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

    // Owns the SHARED single-list bases opened alongside the personal base.
    // Constructed before initAutobase so a registry replay during init can
    // schedule a reconcile against it.
    baseManager = createBaseManager({
        openShared: openSharedForManager,
        closeShared: closeSharedForManager,
    })

    await initAutobase(baseKey).then(() => {
        logger.log('[INFO] Autobase ready 123')
    }).catch((err) => {
        logger.log('[ERROR] initAutobase failed at startup:', err)
        throw err
    })

    // Open any shared single-list bases the personal registry already references.
    await reconcileSharedBases()

    // Recover any list whose shared base is permanently unreachable (its items
    // were stranded by a share into a base this device can't open). Runs in the
    // BACKGROUND — never block startup on it, since on a base that cannot yet
    // flush each resurrect write waits out the flush gate (the renderer would
    // otherwise time out with "could not start the backend"). Idempotent and
    // self-limiting; retries internally until the writer can flush.
    healOrphanedSharedLists().catch((e) => logger.log('[ERROR] boot orphan-heal failed:', e))

    // Rolling scheduled backups (15‑min / daily / weekly). No‑op until a backup
    // password is set; the catch‑up pass inside takes any tier that is due now.
    startScheduledBackups()

    // A real user mutation stamps the presence heartbeat's lastInteractionAt (in
    // memory; the next scheduled beat carries it — no extra write). The heartbeat
    // itself is armed per-base by network.mjs's boot tail.
    setMutationHook(notePresenceInteraction)

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
                    replyMutationResult(req, await addItem(payload))
                    break
                }
                const route = resolveWriteContext(payload)
                if (route === WRITE_REFUSED) { replyMutationResult(req, false); break }
                replyMutationResult(req, await addItem(payload?.text, payload?.listId, payload?.listType, payload, route))
                break
            }
            case RPC_UPDATE: {
                const data = JSON.parse(req.data.toString())
                const route = resolveWriteContext(data.item)
                if (route === WRITE_REFUSED) { replyMutationResult(req, false); break }
                replyMutationResult(req, await updateItem(data.item, route))
                break
            }
            case RPC_DELETE: {
                const data = JSON.parse(req.data.toString())
                const route = resolveWriteContext(data.item)
                if (route === WRITE_REFUSED) { replyMutationResult(req, false); break }
                replyMutationResult(req, await deleteItem(data.item, route))
                break
            }
            case RPC_MOVE: {
                const data = JSON.parse(req.data.toString())
                // A move is add(dest)+delete(source) on ONE base. Route by the
                // SOURCE item's base. A cross-base move (source and destination
                // in different bases) is not supported — refuse it rather than
                // append the destination into the source base (silent misfile).
                const route = resolveWriteContext(data.item)
                if (route === WRITE_REFUSED) { replyMutationResult(req, false); break }
                // The destination base is whatever the TARGET list maps to; if it
                // differs from the source's base the move would land the copy in
                // the wrong base, so refuse it.
                const destRoute = resolveWriteContext({ listId: data.targetListId })
                if (destRoute === WRITE_REFUSED || destRoute !== route) {
                    logger.log('[WARNING] MOVE refused; cross-base moves are not supported')
                    replyMutationResult(req, false)
                    break
                }
                replyMutationResult(req, await moveItem(data, route))
                break
            }
            case RPC_SHARE_LIST: {
                logger.log('[INFO] Command RPC_SHARE_LIST')
                const data = parseRpcJson(req.data) || {}
                const result = await shareList(data.listId)
                if (typeof req?.reply === 'function') {
                    try { req.reply(JSON.stringify(result)) } catch (e) { logger.log('[ERROR] reply share-list:', e) }
                }
                // Also surface over RPC_MESSAGE for transports that don't read replies.
                notifyFrontend({ type: 'share-list-result', listId: data.listId, ...result })
                break
            }
            case RPC_JOIN_LIST: {
                logger.log('[INFO] Command RPC_JOIN_LIST')
                const data = parseRpcJson(req.data) || {}
                const result = await joinList(data.invite)
                if (typeof req?.reply === 'function') {
                    try { req.reply(JSON.stringify(result)) } catch (e) { logger.log('[ERROR] reply join-list:', e) }
                }
                notifyFrontend({ type: 'join-list-result', ...result })
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
                projectItemsToFrontend(await rebuildExtraListItems())
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
            case RPC_SET_BOARD_CONFIG: {
                logger.log('[INFO] Command RPC_SET_BOARD_CONFIG')
                const data = parseRpcJson(req.data)
                if (!autobase || !canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
                    notifyFrontend({ type: 'config-denied', reason: 'not-owner' })
                    break
                }
                try {
                    const base = boardConfigState?.config || normalizeBoardConfig(null)
                    const merged = normalizeBoardConfig({ ...base, ...(data?.config || {}) })
                    const record = createBoardConfigRecord({
                        ownerAuthorityKeyPair,
                        baseKey: autobase.key.toString('hex'),
                        config: merged,
                        sequence: nextBoardConfigSequence(boardConfigState),
                        createdAt: Date.now(),
                    })
                    await autobase.append(record)
                    await autobase.update()
                } catch (e) {
                    logger.log('[ERROR] Failed to set board config:', e)
                    notifyFrontend({ type: 'config-denied', reason: 'error' })
                }
                break
            }
            case RPC_GET_BOARD_CONFIG: {
                logger.log('[INFO] Command RPC_GET_BOARD_CONFIG')
                broadcastBoardConfig()
                break
            }
            case RPC_EXPORT_DATA: {
                logger.log('[INFO] Command RPC_EXPORT_DATA')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => ({
                    ok: true,
                    kind: 'data',
                    file: await exportDataBackup(data?.password),
                }))
                break
            }
            case RPC_EXPORT_SEED: {
                logger.log('[INFO] Command RPC_EXPORT_SEED')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => ({
                    ok: true,
                    kind: 'seed',
                    file: await exportSeedBackup(data?.password),
                }))
                break
            }
            case RPC_IMPORT: {
                logger.log('[INFO] Command RPC_IMPORT')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => {
                    const result = await importBackup(data?.password, data?.file)
                    if (result.kind === 'data' && result.applied?.boardConfigSkipped) {
                        notifyFrontend({ type: 'import-board-config-skipped' })
                    }
                    return { ok: true, ...result }
                })
                break
            }
            case RPC_LIST_BACKUPS: {
                logger.log('[INFO] Command RPC_LIST_BACKUPS')
                await replyBackupResult(req, async () => ({
                    ok: true,
                    backups: listAutoBackups(),
                    passwordSet: isBackupPasswordSet(),
                    schedule: scheduleState(),
                }))
                break
            }
            case RPC_RESTORE_BACKUP: {
                logger.log('[INFO] Command RPC_RESTORE_BACKUP')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => {
                    const result = await restoreAutoBackup(data?.file, data?.password)
                    if (result.kind === 'data' && result.applied?.boardConfigSkipped) {
                        notifyFrontend({ type: 'import-board-config-skipped' })
                    }
                    return { ok: true, ...result }
                })
                break
            }
            case RPC_SET_BACKUP_PASSWORD: {
                logger.log('[INFO] Command RPC_SET_BACKUP_PASSWORD')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => {
                    await setBackupPassword({ current: data?.current, next: data?.next })
                    // A freshly set password unlocks the schedule: restart it so
                    // the catch-up pass writes the first rolling files now.
                    startScheduledBackups()
                    return { ok: true }
                })
                break
            }
            case RPC_SET_BACKUP_SCHEDULE: {
                logger.log('[INFO] Command RPC_SET_BACKUP_SCHEDULE')
                const data = parseRpcJson(req.data)
                await replyBackupResult(req, async () => {
                    setScheduleEnabled(data?.enabled !== false)
                    startScheduledBackups()
                    return { ok: true, schedule: scheduleState() }
                })
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

// Answer the requester with the mutation outcome where the transport supports
// replies (the in-process desktop/headless channel and the node test rpc do;
// bare-rpc requests also expose reply but the mobile app does not read it
// yet). Without this a refused mutation — not writable, or sync stalled with
// no reachable peer — is indistinguishable from a committed one.
function replyMutationResult(req, ok) {
    if (typeof req?.reply !== 'function') return
    try {
        req.reply(JSON.stringify({ ok: ok !== false, reason: ok !== false ? null : 'mutation-refused' }))
    } catch (e) {
        logger.log('[ERROR] Failed to reply with mutation result:', e)
    }
}

// Run a backup export/import and reply with the result over the request
// channel (desktop/headless and the node test rpc support replies; the mobile
// bridge reads them too for these commands). Errors are mapped to a stable
// `reason` the frontend turns into a localized message — never a raw stack.
async function replyBackupResult(req, run) {
    let payload
    try {
        payload = await run()
    } catch (e) {
        const message = e?.message || 'error'
        const reason = message === 'seed-incomplete'
            ? 'seed-incomplete'
            : /password|tampered/i.test(message)
                ? 'bad-password'
                : /not a valid|corrupt|unrecognized|seed-invalid/i.test(message)
                    ? 'invalid-file'
                    : 'error'
        payload = { ok: false, reason }
        if (Array.isArray(e?.missing)) payload.missing = e.missing
        logger.log('[WARNING] Backup operation failed:', reason)
    }
    if (typeof req?.reply !== 'function') return
    try {
        req.reply(JSON.stringify(payload))
    } catch (e) {
        logger.log('[ERROR] Failed to reply with backup result:', e)
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

    // Flush a final presence beat while the swarm + base are still up, so last-seen
    // and cumulative online time stay accurate across a clean shutdown. Best-effort
    // and writable-gated; a crash loses at most one interval of accrual.
    stopPresenceHeartbeat()
    try { await writeHeartbeat({ final: true }) } catch (e) { logger.log('[WARNING] presence final flush failed:', e?.message ?? e) }

    // Close every shared single-list base before the personal base.
    stopScheduledBackups()
    if (_reconcileTimer) { clearTimeout(_reconcileTimer); _reconcileTimer = null }
    if (_healRetryTimer) { clearTimeout(_healRetryTimer); _healRetryTimer = null }
    if (baseManager) {
        for (const ctx of baseManager.list()) {
            try { await closeSharedBase(ctx) } catch (e) { logger.log('[ERROR] Error closing shared base:', e) }
        }
        _listIdToBaseKey.clear()
        baseManager = null
    }

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

// Push the current board config and whether this device can administer it
// (holds the board creator's owner authority).
function broadcastBoardConfig(ctx = primaryContext) {
    const config = ctx.boardConfigState?.config || normalizeBoardConfig(null)
    const canAdminister = canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair)
    notifyFrontend({ type: 'board-config', config, canAdminister })
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

// The personal (primary) base's context: a thin ADAPTER over the single global
// state in state.mjs, so apply() can be written context-aware while the personal
// base behaves EXACTLY as before (the getters/setters read/write the same live
// globals). Shared single-list bases instead pass their own createBaseContext()
// object — same shape, independent per-base state. `role: 'personal'` marks this
// adapter so apply leaves the personal base's frontend pushes untagged.
export const primaryContext = {
    role: 'personal',
    get autobase () { return autobase },
    get membershipState () { return membershipState },
    setMembershipState,
    get boardConfigState () { return boardConfigState },
    setBoardConfigState,
    get currentList () { return currentList },
    setCurrentList,
    get epochKey () { return epochKey },
    setEpochKey,
    get epochEncryptionKeyPair () { return epochEncryptionKeyPair },
    get ownerAuthorityKeyPair () { return ownerAuthorityKeyPair },
    applyMembershipCheckpoint,
}

// Push an item op from apply() to the frontend. For the personal base this is
// byte-identical to before (the bare item over `command`). For a SHARED base the
// payload is tagged with its baseKey (hex) so the UI routes it to that shared
// list's bucket. Null-safe so apply() can run on a base with no RPC channel.
function pushFromBackend (ctx, command, item) {
    if (!rpc) return
    try {
        const payload = ctx.role === 'shared' && ctx.baseKey
            ? { ...item, baseKey: b4a.toString(ctx.baseKey, 'hex') }
            : item
        rpc.request(command).send(JSON.stringify(payload))
    } catch (e) {
        logger.log('[ERROR] pushFromBackend failed:', e)
    }
}

// ---- Single-list sharing: shared-base manager + registry-driven reconcile ----

function sharedStorageDir (dirName) {
    return `${storagePath}/shared/${dirName}`
}

// A shared base's Corestore dir cannot be named by its base key (the key isn't
// known until the store exists), so a small JSON index maps baseKeyHex → dir
// name. It lets reconcile re-open, on restart, exactly the shared bases this
// device has LOCALLY joined/created (those with per-base secrets on disk).
function sharedIndexPath () {
    return `${storagePath}/shared/index.json`
}

function loadSharedIndex () {
    try {
        const fsA = getBackendFs()
        if (!fsA.existsSync(sharedIndexPath())) return {}
        const raw = fsA.readFileSync(sharedIndexPath(), 'utf8')
        const obj = JSON.parse(raw)
        return obj && typeof obj === 'object' ? obj : {}
    } catch (e) {
        // A corrupt index would otherwise be silently overwritten by the next
        // record (losing every other base's entry). Preserve a copy so the
        // entries can be recovered, and surface it loudly.
        logger.log('[ERROR] loadSharedIndex: shared-base index is unreadable; preserving a .corrupt copy', e)
        try {
            const fsA = getBackendFs()
            if (fsA.existsSync(sharedIndexPath())) fsA.renameSync(sharedIndexPath(), `${sharedIndexPath()}.corrupt`)
        } catch (_) {}
        return {}
    }
}

// Writes to index.json are serialized through this chain (handleFrontendRequest
// runs RPCs concurrently, so two near-simultaneous share/join ops could
// otherwise read-modify-write the same stale index and clobber each other).
let _indexWriteChain = Promise.resolve()

function recordSharedBaseDir (baseKeyHex, dirName) {
    _indexWriteChain = _indexWriteChain.then(() => {
        try {
            const fsA = getBackendFs()
            const idx = loadSharedIndex()
            if (idx[baseKeyHex] === dirName) return
            idx[baseKeyHex] = dirName
            try { fsA.mkdirSync(`${storagePath}/shared`, { recursive: true }) } catch (e) { logger.log('[ERROR] recordSharedBaseDir mkdir:', e) }
            // Atomic write: a truncated write (crash/power loss) must not corrupt
            // the live index — write a temp file then rename over it.
            const tmp = `${sharedIndexPath()}.tmp`
            fsA.writeFileSync(tmp, JSON.stringify(idx))
            fsA.renameSync(tmp, sharedIndexPath())
        } catch (e) { logger.log('[ERROR] recordSharedBaseDir:', e) }
    })
    return _indexWriteChain
}

// Push a shared base's already-materialized items to the frontend, each tagged
// with its baseKey so the UI routes them to that shared list's bucket (the
// per-item analogue of projectItemsToFrontend, but base-tagged). Items that
// arrive later via replication are pushed by apply()→pushFromBackend.
function projectSharedListToFrontend (ctx) {
    if (!rpc || !ctx || !Array.isArray(ctx.currentList)) return
    const baseKeyHex = ctx.baseKey ? b4a.toString(ctx.baseKey, 'hex') : null
    for (const item of ctx.currentList) {
        if (!item) continue
        try {
            const payload = baseKeyHex ? { ...item, baseKey: baseKeyHex } : item
            rpc.request(RPC_ADD_FROM_BACKEND).send(JSON.stringify(payload))
        } catch (e) {
            logger.log('[ERROR] Failed to project shared item to frontend:', e)
        }
    }
}

// reconcile() asks the manager to open a registry-referenced shared base that is
// not already open. Three cases:
//  - LOCAL (an index entry + per-base secrets on disk): a base shared/joined in a
//    past session — reopen it.
//  - AUTO-JOIN (no local copy, but the __sharedcreds__ channel carried its read
//    credentials from a paired device): open it read-only and request write
//    access. This is cross-device auto-join — your shared lists follow you.
//  - neither: skip (we can't open a base we have no key for).
async function openSharedForManager (baseKeyHex) {
    const dirName = loadSharedIndex()[baseKeyHex]
    const ctx = dirName ? await reopenLocalSharedBase(baseKeyHex, dirName) : await autoJoinSharedForManager(baseKeyHex)
    if (!ctx) return null
    // Owner: re-arm the pairing listener so it keeps accepting invite joiners.
    if (canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair)) setupSharedPairing(ctx)
    // Not yet a writer and not the owner ⇒ ask the owner to authorize us (the
    // write half of cross-device auto-join). Idempotent (LWW request item).
    else if (!ctx.autobase.writable) await requestSharedWriteAccess(ctx)
    projectSharedListToFrontend(ctx)
    broadcastMembershipRoster(ctx)
    return ctx
}

async function reopenLocalSharedBase (baseKeyHex, dirName) {
    const storageDir = sharedStorageDir(dirName)
    // The index can drift from disk (dir deleted / lost). Opening a fresh empty
    // Corestore there would silently present a blank, editable list (data loss).
    try {
        if (!getBackendFs().existsSync(storageDir)) {
            logger.log('[ERROR] Shared base storage dir missing on reopen; skipping (not recreating empty)', { baseKey: baseKeyHex.slice(0, 16), dirName })
            return null
        }
    } catch (_) {}
    let ctx = null
    try {
        ctx = createBaseContext({ role: 'shared', baseId: baseKeyHex, baseKey: b4a.from(baseKeyHex, 'hex') })
        await openSharedBase(ctx, { baseKey: ctx.baseKey, storageDir, bootstrap: swarmBootstrap })
        // A real shared base ALWAYS has an epoch (bootstrap epoch 1, or a joined
        // one). No epoch key after reopen ⇒ the per-base secrets are missing/
        // corrupt; reopening would skip every encrypted op (silent divergence).
        if (!ctx.epochKey) {
            logger.log('[ERROR] Reopened shared base has no epoch key (secrets missing/corrupt); skipping', baseKeyHex.slice(0, 16))
            await closeSharedBase(ctx)
            return null
        }
        logger.log('[INFO] Reopened shared base on boot', { baseKey: baseKeyHex.slice(0, 16), writable: ctx.autobase.writable })
        return ctx
    } catch (e) {
        logger.log('[ERROR] Failed to reopen shared base:', baseKeyHex?.slice?.(0, 16), e)
        if (ctx) { try { await closeSharedBase(ctx) } catch (_) {} }
        return null
    }
}

// Cross-device auto-join (no invite): open a registry-referenced base read-only
// using the credentials a paired device propagated via __sharedcreds__.
async function autoJoinSharedForManager (baseKeyHex) {
    const creds = _sharedCredsByBaseKey.get(baseKeyHex)
    // Need BOTH the encryption key (to open) and the epoch key (to decrypt); an
    // incomplete bundle would open an undecryptable base, so skip until it syncs.
    if (!creds || !creds.encKey || !creds.epochKey) {
        logger.log('[INFO] Shared base in registry but no local copy and no/incomplete propagated creds — skipping', baseKeyHex?.slice?.(0, 16))
        return null
    }
    try {
        // The joining device knows the base key up front, so name its dir by it.
        const { ctx } = await autoOpenSharedBase(createBaseContext, {
            baseKeyHex,
            creds,
            storageDir: sharedStorageDir(baseKeyHex),
            bootstrap: swarmBootstrap,
        })
        recordSharedBaseDir(baseKeyHex, baseKeyHex)
        logger.log('[INFO] Auto-joined shared base from propagated creds', { baseKey: baseKeyHex.slice(0, 16), writable: ctx.autobase.writable })
        return ctx
    } catch (e) {
        logger.log('[ERROR] Auto-join shared base failed:', baseKeyHex?.slice?.(0, 16), e)
        return null
    }
}

// Record (idempotently) a write-access request for an auto-opened base in the
// personal base, so the owner device authorizes our writer key on its reconcile.
async function requestSharedWriteAccess (ctx) {
    try {
        const writerKey = ctx.autobase?.local?.key ? b4a.toString(ctx.autobase.local.key, 'hex') : null
        if (!writerKey) return
        const epochPublicKey = ctx.epochEncryptionKeyPair ? epochPublicKeyHex(ctx.epochEncryptionKeyPair) : null
        await updateItem(buildSharedJoinReqItem({ baseKey: ctx.baseId, writerKey, epochPublicKey, updatedAt: Date.now() }))
        logger.log('[INFO] Requested cross-device write access', { baseKey: ctx.baseId.slice(0, 16) })
    } catch (e) {
        logger.log('[ERROR] requestSharedWriteAccess failed:', e)
    }
}

// Owner side: authorize any pending write-access requests for the shared bases
// this device owns and has open. Runs on every reconcile (a synced request item
// triggers one). Single authorizer per base ⇒ clean membership sequencing.
async function authorizePendingJoinRequests (joinReqs) {
    if (!baseManager || !Array.isArray(joinReqs) || joinReqs.length === 0) return
    for (const ctx of baseManager.list()) {
        if (!ctx?.autobase?.writable) continue
        if (!canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair)) continue
        for (const req of joinReqs) {
            if (req.baseKey !== ctx.baseId) continue
            if (ctx.membershipState.writers.has(req.writerKey)) continue
            await authorizeWriterOnSharedBase(ctx, { writerKey: req.writerKey, epochPublicKey: req.epochPublicKey })
        }
    }
}

async function closeSharedForManager (_baseKeyHex, ctx) {
    if (!ctx) return
    clearWriteChain(ctx) // release the closed base's per-base write chain
    await closeSharedBase(ctx)
}

// Diff the personal registry's shared-base references against what's open and
// open/close to converge. This is what auto-opens a device's shared lists on
// boot and auto-joins them after a paired device syncs a new registry entry.
// Serialized: two overlapping reconciles could each see a base as not-open and
// both open it (duplicate Corestore on one dir). The chain makes them run one
// at a time; each reads the latest registry at its turn.
let _reconcileChain = Promise.resolve()
function reconcileSharedBases () {
    _reconcileChain = _reconcileChain.then(doReconcileSharedBases, doReconcileSharedBases)
    return _reconcileChain
}

async function doReconcileSharedBases () {
    if (!baseManager) return
    // Only reconcile against a STABLE personal base. During an initAutobase
    // teardown/switch the personal autobase is briefly null/closing and
    // rebuildAllItems would return []; reconciling on that would wrongly clear
    // the routing index and close every shared base. A re-init re-triggers a
    // reconcile once the new base is ready (apply replay → scheduleReconcile,
    // and the explicit boot reconcile).
    if (!autobase || autobase.closing) return
    try {
        const personalItems = await rebuildAllItems()
        const registry = reduceRegistry(personalItems)
        // Refresh the listId → shared-base-key routing index used by writes.
        // 'default' multiplexes the built-in surfaces and is never base-routed, so
        // a (poisoned/legacy) regBaseKey on it is ignored here too.
        _listIdToBaseKey.clear()
        for (const list of registry.lists) {
            if (list && list.baseKey && list.id !== DEFAULT_LIST_ID) _listIdToBaseKey.set(list.id, list.baseKey)
        }
        // Refresh propagated read-credentials (drives cross-device auto-open).
        _sharedCredsByBaseKey.clear()
        for (const [baseKey, creds] of reduceSharedCreds(personalItems)) _sharedCredsByBaseKey.set(baseKey, creds)

        const { opened, closed } = await baseManager.reconcile(registry)
        if (opened.length || closed.length) {
            logger.log('[INFO] Shared bases reconciled', { opened, closed, open: baseManager.keys().length })
        }
        // Owner side: authorize any pending cross-device write-access requests for
        // the bases we own (the write half of auto-join).
        await authorizePendingJoinRequests(reduceSharedJoinReqs(personalItems))
    } catch (e) {
        logger.log('[ERROR] reconcileSharedBases failed:', e)
    }
}

// --- ORPHANED-SHARED-LIST SELF-HEAL ---------------------------------------
// A list whose registry entry points at a shared base this device can never
// open (no local storage AND no propagated read-credentials) has its items
// stranded: shareList moved them into that base and tombstoned the personal
// copies, so the list renders empty. When the originals still live in the
// durable personal log, re-point the list at the personal base and resurrect
// them. See lib/orphan-heal.mjs for the (pure, tested) decision logic.

// Device-local marker of base keys already healed, so a heal runs at most once
// per base even if its registry entry lingers. Stored beside the storage root.
function healedOrphansPath () { return `${storagePath}-healed-orphans.json` }

function loadHealedOrphans () {
    try {
        const fsA = getBackendFs()
        if (!fsA.existsSync(healedOrphansPath())) return new Set()
        const arr = JSON.parse(fsA.readFileSync(healedOrphansPath(), 'utf8'))
        return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
    } catch (e) {
        logger.log('[WARNING] loadHealedOrphans unreadable; treating as empty:', e?.message ?? e)
        return new Set()
    }
}

function markHealedOrphan (baseKeyHex) {
    try {
        const fsA = getBackendFs()
        const s = loadHealedOrphans()
        s.add(baseKeyHex)
        const tmp = `${healedOrphansPath()}.tmp`
        fsA.writeFileSync(tmp, JSON.stringify([...s]))
        fsA.renameSync(tmp, healedOrphansPath())
    } catch (e) {
        logger.log('[ERROR] markHealedOrphan:', e)
    }
}

let _healing = false
let _healRetryTimer = null
let _healAttempts = 0
const HEAL_RETRY_MS = 30000
const HEAL_MAX_ATTEMPTS = 20 // ~10 min of retries; the next app start retries afresh

// Read the linearized view once and reduce it to the tombstoned-item set
// (keyed listId -> id -> last-known full payload). Used only by the heal.
async function collectTombstonedFromView () {
    if (!autobase || !autobase.view) return new Map()
    try { await autobase.update() } catch (_) {}
    const view = autobase.view
    const entries = []
    for (let i = 0; i < view.length; i++) {
        try { entries.push(await view.get(i)) } catch (_) { /* skip unreadable */ }
    }
    return tombstonedFromLog(entries)
}

export async function healOrphanedSharedLists () {
    if (_healing || !autobase || autobase.closing || !baseManager) return
    _healing = true
    try {
        const all = await rebuildAllItems()
        const registry = reduceRegistry(all)
        const healed = loadHealedOrphans()
        const localDirs = loadSharedIndex()
        const liveByList = new Map()
        for (const it of all) {
            if (it && typeof it.listId === 'string' && !isRegistryItem(it) && !isInternalChannelItem(it)) {
                liveByList.set(it.listId, (liveByList.get(it.listId) || 0) + 1)
            }
        }

        // USABLE creds (encKey + epochKey) would have auto-opened the base, so a
        // base that is not open despite usable creds is transient (reconcile will
        // retry) — skip it. Absent OR incomplete creds mean the base can never be
        // opened here: shareList self-propagates creds, so the orphaned base has an
        // entry, but an incomplete one. Gate on usability, not mere presence.
        const credsUsable = (k) => { const c = _sharedCredsByBaseKey.get(k); return !!(c && c.encKey && c.epochKey) }
        const candidates = registry.lists.filter((l) => l && l.baseKey
            && !baseManager.get(l.baseKey)
            && !credsUsable(l.baseKey)
            && !localDirs[l.baseKey]
            && !healed.has(l.baseKey)
            && (liveByList.get(l.id) || 0) === 0)
        if (candidates.length === 0) return

        // Only scan the (potentially large) view when there is a candidate.
        const tomb = await collectTombstonedFromView()
        const plans = planOrphanedListHeals({
            lists: candidates,
            isBaseOpen: (k) => !!baseManager.get(k),
            hasCreds: (k) => credsUsable(k),
            hasLocalDir: (k) => !!localDirs[k],
            isHealed: (k) => healed.has(k),
            liveCount: (id) => liveByList.get(id) || 0,
            tombstoned: (id) => [...(tomb.get(id)?.values() ?? [])],
        })
        if (plans.length === 0) return

        _healAttempts++
        let anyIncomplete = false
        for (const plan of plans) {
            // Log the attempt only on the first pass and then sparsely, so a base
            // that can never flush does not spam the log every retry.
            if (_healAttempts === 1 || _healAttempts % 10 === 0) {
                logger.log('[AUDIT] Healing orphaned shared list', { listId: plan.listId, name: plan.list.name, recoverable: plan.items.length, baseKey: String(plan.baseKey).slice(0, 16), attempt: _healAttempts })
            }
            // 1) Un-share: re-point the registry entry at the personal base. If
            // this single write cannot flush (no reachable indexer yet), BAIL the
            // whole plan and retry later — never grind through dozens of writes
            // that will each just wait out the flush gate (that blocked startup
            // for minutes when the heal was awaited on boot).
            let ok = await updateItem(buildListMetaItem({
                id: plan.list.id,
                name: plan.list.name || plan.list.id,
                type: plan.list.type || DEFAULT_LIST_TYPE,
                groupId: plan.list.groupId ?? null,
                order: typeof plan.list.order === 'number' ? plan.list.order : 0,
                view: plan.list.view,
                baseKey: null,
                updatedAt: Date.now(),
            }))
            // 2) Resurrect each tombstoned item (original id + fields preserved,
            // so day-plan pointers still resolve), with strictly-increasing
            // timestamps so the resurrect wins LWW over any stale update. Stop at
            // the first write that cannot flush — the rest would fail the same way.
            let stamp = Date.now()
            let restored = 0
            if (ok) {
                for (const item of plan.items) {
                    if (await updateItem({ ...item, listId: plan.list.id, updatedAt: ++stamp })) restored++
                    else { ok = false; break }
                }
            }
            if (ok && restored === plan.items.length) {
                markHealedOrphan(plan.baseKey)
                logger.log('[AUDIT] Orphaned list healed', { listId: plan.listId, restored })
            } else {
                anyIncomplete = true
                if (_healAttempts === 1 || _healAttempts % 10 === 0) {
                    logger.log('[WARNING] Orphaned-list heal incomplete (local writer could not flush yet); will retry', { listId: plan.listId, restored, of: plan.items.length, attempt: _healAttempts })
                }
            }
        }

        // A heal that could not flush (no reachable indexer yet) retries without a
        // restart, so it completes whenever connectivity is restored — but only up
        // to a bound, after which the next app start retries afresh (avoids an
        // unbounded timer for a base that can genuinely never be reached).
        if (anyIncomplete && !_healRetryTimer && _healAttempts < HEAL_MAX_ATTEMPTS) {
            _healRetryTimer = setTimeout(() => {
                _healRetryTimer = null
                healOrphanedSharedLists().catch((e) => logger.log('[ERROR] orphan-heal retry failed:', e))
            }, HEAL_RETRY_MS)
        } else if (anyIncomplete && _healAttempts >= HEAL_MAX_ATTEMPTS) {
            logger.log('[WARNING] Orphaned-list heal still cannot flush after max attempts; will retry on next app start')
        }
    } catch (e) {
        logger.log('[ERROR] healOrphanedSharedLists failed:', e)
    } finally {
        _healing = false
    }
}

// Keep the listId → shared-base routing index in step with a registry change
// the instant apply() linearizes it — closing the window between a registry
// item arriving (which schedules an ASYNC reconcile) and a write for that list
// being routed. Only list meta-items carry regBaseKey; a list with a regBaseKey
// maps to its shared base. We never delete here on a tombstone/unshare — the
// authoritative reconcile rebuilds the whole index — so the entry stays and the
// write is REFUSED-if-closed rather than silently misrouted to the personal base.
function indexRegistryItemRoute (item) {
    if (!item || item.regKind !== REG_KIND_LIST) return
    const id = typeof item.id === 'string' ? item.id : null
    if (!id || id === DEFAULT_LIST_ID) return // 'default' is never base-routed (see resolveWriteContext)
    if (item.regDeleted !== true && typeof item.regBaseKey === 'string' && item.regBaseKey) {
        _listIdToBaseKey.set(id, item.regBaseKey)
    }
}

// A base SWITCH (a destructive whole-project join replaces the personal base)
// abandons the current project; its shared single-list bases belong to that
// project, so close them and clear the routing index before the new base loads.
// The new base's registry then drives a fresh reconcile. Called by initAutobase
// only when it is replacing an existing base (never on first boot).
export async function resetSharedBasesOnBaseSwitch () {
    if (_reconcileTimer) { clearTimeout(_reconcileTimer); _reconcileTimer = null }
    if (!baseManager) return
    for (const key of baseManager.keys()) {
        const ctx = baseManager.get(key)
        if (ctx) {
            try { clearWriteChain(ctx) } catch (e) { logger.log('[ERROR] base-switch clearWriteChain:', e) }
            try { await closeSharedBase(ctx) } catch (e) { logger.log('[ERROR] base-switch close shared base:', e) }
        }
        baseManager.remove(key)
    }
    _listIdToBaseKey.clear()
}

// A registry change can arrive locally (an RPC) or from a peer (apply). Coalesce
// bursts and run the reconcile OUTSIDE the apply() callback (deferred) so it
// never re-enters the linearizer it was triggered from.
function scheduleReconcileSharedBases () {
    if (_reconcileTimer) return
    _reconcileTimer = setTimeout(() => {
        _reconcileTimer = null
        reconcileSharedBases().catch((e) => logger.log('[ERROR] scheduled reconcile failed:', e))
    }, 0)
}

// Decide which base a mutation targets. An explicit payload.baseKey wins;
// otherwise the listId → shared-base index (from the personal registry's
// regBaseKey) is consulted. A named-but-not-open base REFUSES the write rather
// than letting it fall through to the personal base (which would file the item
// in the wrong base). No key named → personal base (returns null).
function resolveWriteContext (payload) {
    if (!payload || typeof payload !== 'object') return null
    // The built-in Groceries/Board/Todo surfaces multiplex listId 'default' and
    // are never shareable, so writes to 'default' ALWAYS belong to the personal
    // base — ignore any baseKey (explicit or indexed). This is the choke point
    // that neutralizes a poisoned/legacy regBaseKey on 'default' reaching us via
    // import or peer replication (it would otherwise silently refuse or misroute
    // every built-in write). The orphan-heal still detects + repairs the registry.
    if (payload.listId === DEFAULT_LIST_ID) return null
    const explicit = typeof payload.baseKey === 'string' && payload.baseKey ? payload.baseKey : null
    const key = explicit || (payload.listId ? _listIdToBaseKey.get(payload.listId) : null) || null
    if (!key) return null
    const ctx = baseManager ? baseManager.get(key) : null
    return ctx || WRITE_REFUSED
}

// Promote a personal list into its OWN shared base and mint a co-edit invite.
// Items are re-seeded into the new base (identity preserved), the personal
// copies are tombstoned, and the personal registry entry is pointed at the new
// base (regBaseKey) so this device — and the UI — route the list there.
async function shareList (listId) {
    if (!baseManager) return { ok: false, reason: 'not-ready' }
    if (!autobase || !autobase.writable) return { ok: false, reason: 'not-writable' }
    if (typeof listId !== 'string' || !listId) return { ok: false, reason: 'bad-list' }
    // The built-in Groceries/Board/Todo surfaces are multiplexed onto the single
    // reserved listId 'default' (differentiated only by listType). Sharing by
    // listId would sweep ALL THREE surfaces' items into one shared base and
    // tombstone the personal copies — silently emptying the other two (and, if
    // that base is later unreachable, stranding every item). Refuse it; only
    // registry-backed named lists (each with its own listId) can be shared.
    if (listId === DEFAULT_LIST_ID) return { ok: false, reason: 'cannot-share-builtin' }

    // Already shared → return a fresh invite from the open base.
    if (_listIdToBaseKey.has(listId)) {
        const existing = baseManager.get(_listIdToBaseKey.get(listId))
        if (existing) return { ok: true, invite: createSharedInvite(existing), baseKey: existing.baseId }
    }

    const all = await rebuildAllItems()
    const items = all.filter((i) => i && i.listId === listId && !isRegistryItem(i))
    const meta = all.find((i) => isRegistryItem(i) && i.regKind === REG_KIND_LIST && i.id === listId)
    if (items.length === 0 && !meta) return { ok: false, reason: 'empty-list' }

    const listType = meta?.regType || items[0]?.listType || 'shopping'
    const name = meta?.regName || (typeof meta?.text === 'string' && meta.text) || listId
    const groupId = meta?.regGroupId ?? null
    const order = typeof meta?.regOrder === 'number' ? meta.regOrder : 0
    const view = meta?.regView

    const ctx = createBaseContext({ role: 'shared' })
    const dirName = `owned-${Math.random().toString(36).slice(2, 12)}`
    let baseKeyHex = null
    // Up to (and including) the personal-registry write everything is reversible:
    // a failure rolls back WITHOUT having tombstoned the personal copies, so no
    // data can be lost. Past that point the share is committed.
    try {
        await openSharedBase(ctx, { baseKey: null, storageDir: sharedStorageDir(dirName), bootstrap: swarmBootstrap })
        await bootstrapSharedOwner(ctx)
        setupSharedPairing(ctx)
        baseKeyHex = ctx.baseId
        recordSharedBaseDir(baseKeyHex, dirName) // so reconcile reopens it on restart

        // Seed the list's items (identity preserved) PLUS a self-describing
        // registry meta-item, so a joiner learns the canonical listId even for
        // an empty list (and never has to guess one — see joinList).
        await seedSharedBase(ctx, [
            ...items,
            buildListMetaItem({ id: listId, name, type: listType, groupId, order, view, updatedAt: Date.now() }),
        ])

        baseManager.register(baseKeyHex, ctx)
        _listIdToBaseKey.set(listId, baseKeyHex)

        // Point the personal registry at the shared base BEFORE tombstoning, and
        // confirm it landed — otherwise a missing regBaseKey would, after a
        // restart, route this list's writes back into the personal base.
        const regOk = await updateItem(buildListMetaItem({ id: listId, name, type: listType, groupId, order, view, baseKey: baseKeyHex, updatedAt: Date.now() }))
        if (!regOk) throw new Error('personal registry update refused')
    } catch (e) {
        logger.log('[ERROR] shareList failed before commit; rolling back:', e)
        if (baseKeyHex) { _listIdToBaseKey.delete(listId); baseManager.remove(baseKeyHex) }
        try { clearWriteChain(ctx) } catch (_) {}
        try { await closeSharedBase(ctx) } catch (_) {}
        return { ok: false, reason: 'share-failed' }
    }

    // Committed: the registry now points at the shared base. Tombstone the
    // personal copies (best-effort) and mint the invite.
    for (const item of items) {
        try { await deleteItem(item) } catch (e) { logger.log('[ERROR] share-list tombstone:', e) }
    }
    // Propagate this base's READ credentials through the personal base so YOUR
    // OTHER devices auto-open (and, once authorized, co-edit) the list without an
    // invite. Best-effort; the explicit invite path works regardless.
    try {
        await updateItem(buildSharedCredItem({
            baseKey: baseKeyHex,
            encKey: ctx.encryptionKey ? b4a.toString(ctx.encryptionKey, 'hex') : null,
            epochKey: ctx.epochKey ? b4a.toString(ctx.epochKey, 'hex') : null,
            updatedAt: Date.now(),
        }))
    } catch (e) { logger.log('[ERROR] share-list creds propagation:', e) }
    projectSharedListToFrontend(ctx)
    broadcastMembershipRoster(ctx) // the owner can administer this shared list
    const invite = createSharedInvite(ctx) || null
    logger.log('[INFO] Shared list promoted to its own base', { listId, baseKey: baseKeyHex.slice(0, 16), invite: !!invite })
    return { ok: true, invite, baseKey: baseKeyHex }
}

// Additively join a shared list's base via its invite (NOT the destructive
// whole-project join). Adds a personal registry entry pointing at the joined
// base so it appears in the nav and routes writes there.
async function joinList (invite) {
    if (!baseManager) return { ok: false, reason: 'not-ready' }
    if (typeof invite !== 'string' || !invite) return { ok: false, reason: 'bad-invite' }
    const dirName = sharedDirNameForInvite(invite)
    if (!dirName) return { ok: false, reason: 'bad-invite' }
    let ctx = null
    let baseKeyHex = null
    try {
        const joined = await joinSharedBaseViaInvite(createBaseContext, {
            invite,
            storageDir: sharedStorageDir(dirName),
            bootstrap: swarmBootstrap,
        })
        ctx = joined.ctx
        baseKeyHex = joined.baseKeyHex
        const writable = joined.writable
        baseManager.register(baseKeyHex, ctx)
        recordSharedBaseDir(baseKeyHex, dirName) // so reconcile reopens it on restart

        // Adopt the shared list's CANONICAL id from the base's own self-describing
        // registry meta-item (or, fallback, a replicated item). Never invent a
        // synthetic id — one that didn't match the real listId would, once the
        // real items arrived, route their writes to the personal base. Fail the
        // join if nothing has described the list within the window.
        let identity = null
        const deadline = Date.now() + 15000
        while (!identity && Date.now() < deadline) {
            try { await ctx.autobase.update() } catch (_) {}
            identity = await sharedListIdentity(ctx)
            if (!identity) await new Promise((r) => setTimeout(r, 250))
        }
        if (!identity) {
            baseManager.remove(baseKeyHex)
            clearWriteChain(ctx)
            await closeSharedBase(ctx)
            return { ok: false, reason: 'join-timeout' }
        }

        // A shared base claiming the reserved 'default' listId would multiplex
        // onto the built-in Groceries/Board/Todo surfaces (and route their writes
        // into it). Refuse — 'default' is never base-routed (see resolveWriteContext).
        if (identity.listId === DEFAULT_LIST_ID) {
            logger.log('[WARNING] join-list refused; shared base claims the reserved built-in listId', { listId: identity.listId })
            baseManager.remove(baseKeyHex)
            clearWriteChain(ctx)
            await closeSharedBase(ctx)
            return { ok: false, reason: 'cannot-join-builtin' }
        }

        // listId-collision guard: if this id already names a DIFFERENT list in
        // your registry (a personal list, or another shared base), joining would
        // collide — the registry and items key by listId. Refuse rather than
        // corrupt. (True re-id with item remapping is a follow-up; re-joining the
        // SAME base is fine — its baseKey matches.)
        const clash = reduceRegistry(await rebuildAllItems()).lists
            .find((l) => l.id === identity.listId && (l.baseKey || null) !== baseKeyHex)
        if (clash) {
            logger.log('[WARNING] join-list refused; listId already in use by another list', { listId: identity.listId })
            baseManager.remove(baseKeyHex)
            clearWriteChain(ctx)
            await closeSharedBase(ctx)
            return { ok: false, reason: 'list-id-conflict' }
        }

        _listIdToBaseKey.set(identity.listId, baseKeyHex)
        const regOk = await updateItem(buildListMetaItem({ id: identity.listId, name: identity.name, type: identity.type, baseKey: baseKeyHex, updatedAt: Date.now() }))
        if (!regOk) {
            _listIdToBaseKey.delete(identity.listId)
            baseManager.remove(baseKeyHex)
            clearWriteChain(ctx)
            await closeSharedBase(ctx)
            return { ok: false, reason: 'registry-write-failed' }
        }

        await rebuildSharedListFromView(ctx)
        projectSharedListToFrontend(ctx)
        broadcastMembershipRoster(ctx) // surface the joined base's membership to the UI
        logger.log('[INFO] Joined shared list', { listId: identity.listId, baseKey: baseKeyHex.slice(0, 16), writable })
        return { ok: true, baseKey: baseKeyHex, listId: identity.listId, writable }
    } catch (e) {
        logger.log('[ERROR] joinList failed:', e)
        if (ctx) {
            if (baseKeyHex) baseManager.remove(baseKeyHex)
            try { clearWriteChain(ctx) } catch (_) {}
            try { await closeSharedBase(ctx) } catch (_) {}
        }
        return { ok: false, reason: 'join-failed' }
    }
}

export async function apply (ctx, nodes, view, host) {
    if (ctx.autobase?.closing) {
        logger.log('[WARNING] Apply called while Autobase is closing; skipping.')
        return
    }
    logger.log('[INFO] Apply started')

    const { membershipRecords, boardConfigRecords } = await ctx.applyMembershipCheckpoint.update(view)
    ctx.setMembershipState(reduceMembershipLog(membershipRecords, { baseKey: ctx.autobase?.key }))
    ctx.setBoardConfigState(reduceBoardConfigLog(boardConfigRecords, {
        baseKey: ctx.autobase?.key,
        ownerAuthorityKey: ctx.membershipState.ownerAuthorityKey,
    }))

    for (const { value } of nodes) {
        if (!value) continue

        if (isMembershipRecord(value)) {
            const result = reduceMembershipOperation(value, ctx.membershipState, { baseKey: ctx.autobase?.key })
            ctx.setMembershipState(result.state)
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
                await adoptGrantedEpochKey(ctx, result)
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
                if (ctx.autobase?.local?.key?.toString('hex') === result.effect.removeWriterKey) {
                    ctx.setEpochKey(null)
                    // Per-base persisted epoch keys for shared bases aren't wired
                    // yet; only the personal base's stored key may be retired here.
                    if (isPersonalContext(ctx)) await deleteEpochKey()
                    logger.log('[AUDIT] Local writer was removed; retired local epoch key')
                }
            }

            // The writer set changed; refresh the frontend roster.
            if (result.effect?.addWriterKey || result.effect?.removeWriterKey) {
                broadcastMembershipRoster(ctx)
            }
            continue
        }

        if (isBoardConfigRecord(value)) {
            // Only the board creator's signature can change the config (verified
            // against the membership owner authority). Persist accepted records
            // into the view so the reduced config survives a restart/reorg.
            const result = reduceBoardConfigOperation(value, ctx.boardConfigState, {
                baseKey: ctx.autobase?.key,
                ownerAuthorityKey: ctx.membershipState.ownerAuthorityKey,
            })
            ctx.setBoardConfigState(result.state)
            if (!result.ok) {
                logger.log('[WARNING] Rejected board-config op', { reason: result.reason })
                continue
            }
            await view.append({ op: 'board-config', record: value })
            broadcastBoardConfig(ctx)
            continue
        }

        const unwrappedOperation = unwrapListOperation(ctx, value)
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

        // A change to the PERSONAL registry (a list shared/renamed/deleted) can
        // add or remove a shared base. Update the write-routing index NOW (so a
        // concurrent write for that list is not misrouted before the async
        // reconcile runs), then schedule the open/close lifecycle. Only the
        // personal base carries the registry; shared bases never do.
        if (isPersonalContext(ctx) && isRegistryItem(operation.value)) {
            indexRegistryItemRoute(operation.value)
            scheduleReconcileSharedBases()
        }
        // Cross-device auto-join channels (propagated read-creds / write-access
        // requests) ride the personal base but are NEVER shown in the UI — they
        // only drive a reconcile (auto-open a sibling's shared base, or authorize
        // a requester). `internalItem` suppresses the frontend push below.
        const internalItem = isInternalChannelItem(operation.value)
        if (isPersonalContext(ctx) && internalItem) scheduleReconcileSharedBases()

        if (operation.type === 'add') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in add operation:', operation.value)
                continue
            }
            // Rigor gate: when the board creator has rigor mode on, a new board
            // ticket must carry the required fields. This is the durable,
            // cluster-wide enforcement behind the frontend's create form — the
            // reduced config is deterministic across peers at this point in
            // linearized history, and the default config is rigor ON.
            if (isBoardType(operation.value.listType) && ctx.boardConfigState?.config?.rigorOn) {
                const check = validateTicketDraft(operation.value, ctx.boardConfigState.config)
                if (!check.ok) {
                    logger.log('[WARNING] Dropped non-rigor board add (rigor mode on); missing:', check.missing)
                    continue
                }
            }
            logger.log('[INFO] Applying add operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            ctx.setCurrentList(applyOperationToList(ctx.currentList, operation))
            if (!internalItem) pushFromBackend(ctx, RPC_ADD_FROM_BACKEND, operation.value)
            continue
        }

        if (operation.type === 'delete') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in delete operation:', operation.value)
                continue
            }
            logger.log('[INFO] Applying delete operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            ctx.setCurrentList(applyOperationToList(ctx.currentList, operation))
            if (!internalItem) pushFromBackend(ctx, RPC_DELETE_FROM_BACKEND, operation.value)
            continue
        }

        if (operation.type === 'update') {
            if (!validateItem(operation.value)) {
                logger.log('[WARNING] Invalid item schema in update operation:', operation.value)
                continue
            }
            logger.log('[INFO] Applying update operation for item:', operation.value)
            await view.append(createListViewEntry(operation))
            ctx.setCurrentList(applyOperationToList(ctx.currentList, operation))
            if (!internalItem) pushFromBackend(ctx, RPC_UPDATE_FROM_BACKEND, operation.value)
            continue
        }

        if (operation.type === 'list') {
            if (!Array.isArray(operation.value)) {
                logger.log('[WARNING] Invalid list operation payload, expected array:', operation.value)
                continue
            }
            logger.log('[INFO] Applying list operation for items:', operation.value)
            await view.append(createListViewEntry(operation))
            const nextList = applyOperationToList(ctx.currentList, operation)
            ctx.setCurrentList(nextList)
            if (rpc) {
                const listPayload = ctx.role === 'shared' && ctx.baseKey
                    ? { list: nextList, baseKey: b4a.toString(ctx.baseKey, 'hex') }
                    : nextList
                rpc.request(SYNC_LIST).send(JSON.stringify(listPayload))
            }
            continue
        }

        // All other values are appended to the view (for future use)
        await view.append(operation)
    }
}

async function adoptGrantedEpochKey(ctx, result) {
    if (!ctx.autobase?.local?.key || !ctx.epochEncryptionKeyPair) return

    const localWriterKey = ctx.autobase.local.key.toString('hex')
    const grantedEpochKey = decryptEpochGrantForWriter(
        result.effect.epochGrants,
        localWriterKey,
        ctx.epochEncryptionKeyPair,
    )
    if (!grantedEpochKey) return

    if (epochKeyHashHex(grantedEpochKey) !== result.effect.epochKeyHash) {
        logger.log('[WARNING] Ignoring epoch grant with mismatched key hash')
        return
    }

    ctx.setEpochKey(grantedEpochKey)
    // Persist the rotated key so it survives a restart: the personal base uses
    // the global secure slot; a shared base persists per-base next to its
    // Corestore (otherwise a reopen would reload the OLD epoch key and could not
    // decrypt anything written under the new one). Shared-base rekey isn't wired
    // yet, but this keeps adoption correct for when it is.
    if (isPersonalContext(ctx)) await saveEpochKey(grantedEpochKey)
    else persistSharedSecrets(ctx)
    logger.log('[INFO] Adopted granted epoch key', {
        epoch: result.state.currentEpoch,
        epochKeyHash: result.effect.epochKeyHash,
    })
}

function unwrapListOperation(ctx, value) {
    if (!isEncryptedListOperation(value)) return value

    if (Number(value.epoch) !== Number(ctx.membershipState?.currentEpoch)) {
        logger.log('[WARNING] Ignoring encrypted list op for inactive epoch', {
            opEpoch: value.epoch,
            currentEpoch: ctx.membershipState?.currentEpoch,
        })
        return null
    }

    const operation = decryptEncryptedListOperation(value, ctx.epochKey)
    if (!operation) {
        logger.log('[WARNING] Could not decrypt encrypted list op for current epoch')
        return null
    }
    return operation
}
