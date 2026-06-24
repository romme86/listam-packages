// The lifecycle of a SHARED single-list base, opened ALONGSIDE the personal base.
//
// It mirrors the personal base's setup in network.mjs (Corestore + Autobase +
// Hyperswarm topic + replication + BlindPairing membership), but everything
// lives on the passed-in BaseContext, and apply() is BOUND to that ctx — so this
// base reduces independently of the personal base and any other shared base
// (their async apply/swarm callbacks interleave). Storage is namespaced per base.
//
// This is the ADDITIVE counterpart of network.mjs: the proven personal path
// there stays byte-identical; the shared path here reuses the same pure
// primitives (membership/epoch/invite codecs) on per-base state.
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import BlindPairing from 'blind-pairing'
import z32 from 'z32'
import b4a from 'b4a'
import hypercoreCrypto from 'hypercore-crypto'
import { apply, open, swarmBootstrap } from '../backend.mjs'
import { getBackendFs } from './platform-fs.mjs'
import { logger } from './logger.mjs'
import { createListOperation } from './list-reducer.mjs'
import { reduceRegistry, isRegistryItem } from './list-registry.mjs'
import { reduceMembershipLog } from './membership.mjs'
import { reduceBoardConfigLog } from './board-config.mjs'
import { prepareListAppendOperation } from './item.mjs'
import {
    canCreateMembershipInvite,
    createAddWriterMembershipRecord,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    nextMembershipSequence,
    ownerAuthorityPublicKeyHex,
    ownerAuthoritySecretKeyHex,
} from './membership.mjs'
import {
    createEpochEncryptionKeyPair,
    decodeInviteEpochData,
    encodeInviteEpochData,
    epochPublicKeyHex,
    epochSecretKeyHex,
    generateEpochKey,
} from './key-epochs.mjs'
import { INVITE_MAX_USES, isInviteUsable, reserveInviteUse, withInvitePolicy } from './invite-policy.mjs'

const ENC_HEX = /^[0-9a-f]{64}$/

// --- Scoped local writer (mirrors network.mjs, but on a passed-in store) ------
// A joiner's writer CORE must be derived from THIS shared base's Corestore and
// be deterministic across restarts (the scope embeds the base discovery key, a
// hash of the base key), so the same writer the host authorized is rebuilt on
// every reopen. The owner (first writer) uses the store's default local writer
// and records no scope.
const LOCAL_WRITER_SCOPE_USERDATA = 'listam/shared-local-writer-scope'

function sharedWriterScopeName (baseDiscoveryKey) {
    return `shared-join-${b4a.toString(baseDiscoveryKey, 'hex')}`
}

async function deriveSharedWriter (store, baseDiscoveryKey) {
    const scopeName = sharedWriterScopeName(baseDiscoveryKey)
    const keyPair = await store.createKeyPair(scopeName)
    const writerKey = await Autobase.getLocalKey(store, { keyPair })
    return { scopeName, keyPair, writerKey }
}

async function recordSharedScopedWriter (store, scopeName) {
    const lc = store.get({ name: 'local' })
    await lc.ready()
    try { await lc.setUserData(LOCAL_WRITER_SCOPE_USERDATA, b4a.from(scopeName)) } finally { await lc.close() }
}

// Reconstruct the scoped writer keypair recorded at join time, validated against
// the base being opened (a scope minted for a different base is ignored). Returns
// null for the owner/first-writer (no scope recorded) → default local writer.
async function loadSharedScopedWriter (store, forBaseKey) {
    const lc = store.get({ name: 'local' })
    await lc.ready()
    let scopeRaw = null
    try { scopeRaw = await lc.getUserData(LOCAL_WRITER_SCOPE_USERDATA) } finally { await lc.close() }
    if (!scopeRaw) return null
    const expected = sharedWriterScopeName(hypercoreCrypto.discoveryKey(forBaseKey))
    if (b4a.toString(scopeRaw) !== expected) return null
    return store.createKeyPair(expected)
}

// --- Pure codec helpers (duplicated from network.mjs to keep this path free of
//     the personal globals graph; they are small and stable) -------------------
function normalizeInviteCode (raw) {
    if (typeof raw !== 'string') return ''
    return raw.trim().replace(/\s+/g, '')
}

function normalizeHex32 (value) {
    let buf = null
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) buf = Buffer.from(value)
    else if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) buf = Buffer.from(value, 'hex')
    return buf && buf.length === 32 ? buf.toString('hex') : null
}

function parseJoinCandidateUserData (userData) {
    if (!userData) return null
    try {
        const parsed = JSON.parse(Buffer.from(userData).toString('utf8'))
        const writerKey = normalizeHex32(parsed?.writerKey)
        const epochPublicKey = normalizeHex32(parsed?.epochPublicKey)
        if (writerKey) return { writerKey, epochPublicKey }
    } catch {}
    const writerKey = normalizeHex32(Buffer.from(userData))
    return writerKey ? { writerKey, epochPublicKey: null } : null
}

// A stable per-base local directory name derived from the invite's discovery
// key (a hash of the base key, so the joiner knows it upfront and reconcile can
// recompute it). Lets the join flow choose its Corestore dir before pairing
// reveals the actual base key.
export function sharedDirNameForInvite (invite) {
    const normalized = normalizeInviteCode(invite)
    if (!normalized) return null
    const info = BlindPairing.decodeInvite(z32.decode(normalized))
    if (!info?.discoveryKey) return null
    return `joined-${b4a.toString(info.discoveryKey, 'hex')}`
}

// --- Per-base secret persistence ----------------------------------------------
// A shared base's epoch key (+ epoch-encryption keypair, + owner authority for
// the owner) live next to its Corestore — the per-base analogue of the personal
// base's secure-store secrets, mirroring the encryption.key already kept here.
// Without this a shared base could not decrypt its own items after a restart and
// the owner could not re-mint invites. (Plaintext-on-disk, like encryption.key:
// the proximity-trust boundary is filesystem access, which already exposes the
// Corestore's encryption key.)
const SECRET_FILES = { epoch: 'epoch.key', epochEnc: 'epoch-enc.key', owner: 'owner.key' }

function writeSecretFile (storageDir, name, hex) {
    try { getBackendFs().writeFileSync(`${storageDir}/${name}`, hex) } catch (e) { logger.log('[ERROR] shared secret persist', name, e) }
}

function readSecretFile (storageDir, name) {
    try {
        const fsA = getBackendFs()
        const p = `${storageDir}/${name}`
        if (!fsA.existsSync(p)) return null
        const hex = fsA.readFileSync(p, 'utf8').trim().toLowerCase()
        return /^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0 ? hex : null
    } catch (e) { logger.log('[ERROR] shared secret read', name, e); return null }
}

// Persist whichever secrets ctx currently holds. Safe to call repeatedly.
export function persistSharedSecrets (ctx) {
    if (!ctx.storageDir) return
    if (ctx.epochKey) writeSecretFile(ctx.storageDir, SECRET_FILES.epoch, b4a.toString(ctx.epochKey, 'hex'))
    const encHex = epochSecretKeyHex(ctx.epochEncryptionKeyPair)
    if (encHex) writeSecretFile(ctx.storageDir, SECRET_FILES.epochEnc, encHex)
    const ownerHex = ownerAuthoritySecretKeyHex(ctx.ownerAuthorityKeyPair)
    if (ownerHex) writeSecretFile(ctx.storageDir, SECRET_FILES.owner, ownerHex)
}

// Load any persisted secrets into ctx (reopen). Must run before apply() can be
// asked to decrypt epoch-encrypted ops.
function loadSharedSecrets (ctx) {
    if (!ctx.storageDir) return
    const epochHex = readSecretFile(ctx.storageDir, SECRET_FILES.epoch)
    if (epochHex && !ctx.epochKey) ctx.setEpochKey(b4a.from(epochHex, 'hex'))
    const encHex = readSecretFile(ctx.storageDir, SECRET_FILES.epochEnc)
    if (encHex && !ctx.epochEncryptionKeyPair) {
        const kp = createEpochEncryptionKeyPair(b4a.from(encHex, 'hex'))
        if (kp) ctx.epochEncryptionKeyPair = kp
    }
    const ownerHex = readSecretFile(ctx.storageDir, SECRET_FILES.owner)
    if (ownerHex && !ctx.ownerAuthorityKeyPair) {
        const kp = createOwnerAuthorityKeyPair(b4a.from(ownerHex, 'hex'))
        if (kp) ctx.ownerAuthorityKeyPair = kp
    }
}

// --- Open / close -------------------------------------------------------------

// Open (and, by default, start replicating) a shared base into `ctx`.
//   baseKey = null  → bootstrap a fresh base (this device is the first writer).
//   baseKey set     → open an existing shared base and replicate it.
// `storageDir` is the per-base Corestore directory. `store`/`keyPair` let the
// join flow reuse a Corestore it already opened (to derive the writer) and pin
// the scoped local writer. `joinSwarm:false` opens without networking (tests).
export async function openSharedBase (ctx, { baseKey = null, encryptionKey = null, storageDir, store = null, keyPair = null, bootstrap = swarmBootstrap, joinSwarm = true } = {}) {
    if (!storageDir) throw new Error('openSharedBase requires a storageDir')

    // A base's encryption key must survive restarts — a fresh base auto-generates
    // one, and losing it makes all its data undecryptable on reopen. Persist it
    // once, per base, next to its Corestore. (Joiners pass the key from the invite.)
    const fsA = getBackendFs()
    const keyFile = `${storageDir}/encryption.key`
    let encKey = encryptionKey
    if (!encKey && fsA.existsSync(keyFile)) {
        const hex = fsA.readFileSync(keyFile, 'utf8').trim().toLowerCase()
        if (ENC_HEX.test(hex)) encKey = b4a.from(hex, 'hex')
    }

    ctx.storageDir = storageDir
    ctx.store = store || new Corestore(storageDir)
    await ctx.store.ready()

    // Pin the local writer: explicit keyPair (join, pre-derived) wins; otherwise
    // a recorded scoped writer (a joiner reopening) is reconstructed; otherwise
    // the store default (the owner/first writer) is used.
    const localKeyPair = keyPair || (baseKey ? await loadSharedScopedWriter(ctx.store, baseKey) : null)

    ctx.autobase = new Autobase(ctx.store, baseKey, {
        apply: (nodes, view, host) => apply(ctx, nodes, view, host),
        open,
        valueEncoding: 'json',
        encrypt: true,
        encryptionKey: encKey || undefined,
        ...(localKeyPair ? { keyPair: localKeyPair } : {}),
    })
    await ctx.autobase.ready()
    ctx.baseKey = ctx.autobase.key
    ctx.encryptionKey = ctx.autobase.encryptionKey
    ctx.baseId = b4a.toString(ctx.autobase.key, 'hex')
    // Restore this base's epoch/owner secrets (reopen) BEFORE update(), so apply
    // can decrypt epoch-encrypted ops and the owner regains invite authority.
    loadSharedSecrets(ctx)
    if (ctx.autobase.encryptionKey && !fsA.existsSync(keyFile)) {
        try { fsA.writeFileSync(keyFile, b4a.toString(ctx.autobase.encryptionKey, 'hex')) } catch (e) { logger.log('[ERROR] shared base key persist:', e) }
    }
    await ctx.autobase.update()
    // Autobase does not re-run apply over history on reopen; rebuild this base's
    // currentList from the persisted view so it survives a restart/auto-open.
    await rebuildSharedListFromView(ctx)

    if (joinSwarm) {
        ctx.swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
        ctx.swarm.on('error', (err) => logger.log('[ERROR] Shared-base swarm error:', err))
        ctx.swarm.on('connection', (conn) => {
            conn.on('error', () => {})
            ctx.peerCount = ctx.swarm.connections.size
            if (ctx.autobase) ctx.autobase.replicate(conn)
            conn.on('close', () => { ctx.peerCount = ctx.swarm.connections.size })
        })
        ctx.discovery = ctx.swarm.join(ctx.autobase.discoveryKey, { server: true, client: true })
        await ctx.discovery.flushed()
    }
    logger.log('[INFO] Opened shared base', { baseId: ctx.baseId.slice(0, 16), writable: ctx.autobase.writable })
    return ctx
}

export async function closeSharedBase (ctx) {
    try { if (ctx.pairing) await ctx.pairing.close() } catch (e) { logger.log('[ERROR] shared close pairing:', e) }
    try { if (ctx.discovery) await ctx.discovery.destroy() } catch (e) { logger.log('[ERROR] shared close discovery:', e) }
    try { if (ctx.swarm) await ctx.swarm.destroy() } catch (e) { logger.log('[ERROR] shared close swarm:', e) }
    try { if (ctx.autobase) await ctx.autobase.close() } catch (e) { logger.log('[ERROR] shared close autobase:', e) }
    try { if (ctx.store) await ctx.store.close() } catch (e) { logger.log('[ERROR] shared close store:', e) }
    ctx.pairing = null
    ctx.pairingMember = null
    ctx.discovery = null
    ctx.swarm = null
    ctx.autobase = null
    ctx.store = null
}

// Rebuild this base's in-memory state (currentList + membership + board config)
// from the persisted view. Needed because Autobase does not re-run apply over
// history on reopen, so a restarted/auto-opened base would otherwise show an
// empty list AND an empty membership (owner unable to mint invites). Idempotent;
// the per-ctx checkpoint resumes its scan, and apply() independently re-derives
// the same membership on its first post-reopen pass.
export async function rebuildSharedListFromView (ctx) {
    if (!ctx.autobase?.view || !ctx.viewCheckpoint) return
    try {
        const { items, membershipRecords, boardConfigRecords } = await ctx.viewCheckpoint.update(ctx.autobase.view, {
            onError: (i, e) => logger.log('[ERROR] shared rebuild entry', i, e?.message ?? e),
        })
        ctx.setMembershipState(reduceMembershipLog(membershipRecords, { baseKey: ctx.autobase?.key }))
        ctx.setBoardConfigState(reduceBoardConfigLog(boardConfigRecords, {
            baseKey: ctx.autobase?.key,
            ownerAuthorityKey: ctx.membershipState.ownerAuthorityKey,
        }))
        ctx.setCurrentList(items)
    } catch (e) {
        logger.log('[ERROR] rebuildSharedListFromView failed:', e)
    }
}

// --- Owner bootstrap (first writer of a fresh shared base) --------------------
export async function bootstrapSharedOwner (ctx) {
    if (!ctx.autobase?.writable) throw new Error('shared base not writable; cannot bootstrap owner')
    // Idempotent: skip if already bootstrapped. Check the keypair too, not just
    // the reduced public key — on a fresh base the public key only appears in
    // membershipState after apply() processes the record, so a second call
    // before then would otherwise mint a SECOND owner keypair that mismatches
    // the one already in the appended bootstrap record.
    if (ctx.membershipState?.ownerAuthorityKey || ctx.ownerAuthorityKeyPair) return

    const ownerKeyPair = createOwnerAuthorityKeyPair()
    const epochEncryptionKeyPair = createEpochEncryptionKeyPair()
    const epochKey = generateEpochKey()
    ctx.ownerAuthorityKeyPair = ownerKeyPair
    ctx.epochEncryptionKeyPair = epochEncryptionKeyPair
    ctx.setEpochKey(epochKey)

    const record = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: ownerKeyPair,
        writerKey: ctx.autobase.local.key,
        baseKey: ctx.autobase.key,
        epochPublicKey: epochPublicKeyHex(epochEncryptionKeyPair),
        epochKey,
        epoch: 1,
    })
    await ctx.autobase.append(record)
    await ctx.autobase.update()
    persistSharedSecrets(ctx) // durable across restarts (epoch + epoch-enc + owner)
    logger.log('[INFO] Bootstrapped shared-base owner', { ownerAuthorityKey: ownerAuthorityPublicKeyHex(ownerKeyPair) })
}

// --- Invite (host) ------------------------------------------------------------
export function createSharedInvite (ctx) {
    if (!ctx.autobase) return null
    if (!canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair)) {
        ctx.currentInvite = null
        ctx.inviteUsesRemaining = 0
        logger.log('[WARNING] Shared invite rejected; only the owner device can create it')
        return null
    }
    const currentEpoch = Number(ctx.membershipState?.currentEpoch) || 0
    if (isInviteUsable(ctx.currentInvite, ctx.inviteUsesRemaining) && ctx.currentInvite.epochAtMint === currentEpoch) {
        return z32.encode(ctx.currentInvite.invite)
    }
    const epochData = encodeInviteEpochData(ctx.epochKey, currentEpoch)
    if (!epochData) {
        logger.log('[WARNING] Shared invite rejected; no current epoch key to embed')
        return null
    }
    const inv = withInvitePolicy(BlindPairing.createInvite(ctx.autobase.key, { data: epochData }))
    inv.epochAtMint = currentEpoch
    ctx.currentInvite = inv
    ctx.inviteUsesRemaining = INVITE_MAX_USES
    return z32.encode(inv.invite)
}

function rotateSharedInvite (ctx) {
    ctx.currentInvite = null
    ctx.inviteUsesRemaining = 0
}

// --- Host-side pairing listener (accepts joiners as writers) ------------------
export function setupSharedPairing (ctx) {
    if (!ctx.autobase || !ctx.swarm) return
    ctx.pairing = new BlindPairing(ctx.swarm)
    ctx.pairingMember = ctx.pairing.addMember({
        discoveryKey: ctx.autobase.discoveryKey,
        onadd: async (candidate) => {
            if (!ctx.currentInvite || !b4a.equals(ctx.currentInvite.id, candidate.inviteId)) {
                try { candidate.close() } catch (_) {}
                return
            }
            const reservation = reserveInviteUse(ctx.currentInvite, ctx.inviteUsesRemaining)
            if (!reservation.ok) {
                try { candidate.close() } catch (_) {}
                rotateSharedInvite(ctx)
                return
            }
            const reservedInvite = ctx.currentInvite
            ctx.inviteUsesRemaining = reservation.usesRemaining
            ctx.currentInvite = null
            try {
                candidate.open(reservedInvite.publicKey)
                if (!ctx.autobase.writable) throw new Error('Shared host is not writable')
                if (!canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair)) {
                    throw new Error('Only the owner device can accept shared-base candidates')
                }
                const joiner = parseJoinCandidateUserData(candidate.userData)
                if (!joiner?.writerKey) throw new Error('Join candidate did not provide a writer key')

                const record = createAddWriterMembershipRecord({
                    ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
                    writerKey: joiner.writerKey,
                    baseKey: ctx.autobase.key,
                    sequence: nextMembershipSequence(ctx.membershipState),
                    epochPublicKey: joiner.epochPublicKey,
                })
                await ctx.autobase.append(record)
                await ctx.autobase.update()

                if (reservedInvite.epochAtMint !== (Number(ctx.membershipState.currentEpoch) || 0)) {
                    throw new Error('Invite was minted for a rotated epoch; rotating invite')
                }
                candidate.confirm({
                    key: ctx.autobase.key,
                    encryptionKey: ctx.autobase.encryptionKey,
                    additional: reservedInvite.additional,
                })
            } catch (e) {
                logger.log('[ERROR] Failed to accept shared-base candidate:', e)
                try { candidate.close() } catch (_) {}
            } finally {
                rotateSharedInvite(ctx)
            }
        },
    })
}

// The canonical identity of the list a shared base holds, read from the base's
// OWN registry meta-item (a self-describing entry seeded at share time), or — as
// a fallback for a base seeded without one — the first real item's listId.
// Returns null until something has replicated, so the joiner waits for the REAL
// listId instead of guessing one that would mis-route later-arriving items.
export async function sharedListIdentity (ctx) {
    if (!ctx.autobase?.view || !ctx.viewCheckpoint) return null
    let allItems = []
    try {
        ({ allItems = [] } = await ctx.viewCheckpoint.update(ctx.autobase.view, { onError: () => {} }))
    } catch { return null }
    const reg = reduceRegistry(allItems)
    if (reg.lists.length > 0) {
        const l = reg.lists[0]
        return { listId: l.id, name: l.name || l.id, type: l.type || 'shopping' }
    }
    const item = allItems.find((i) => i && !isRegistryItem(i) && typeof i.listId === 'string')
    if (item) return { listId: item.listId, name: item.listId, type: item.listType || 'shopping' }
    return null
}

// --- Seeding (promote: re-emit a list's items into the new shared base) -------
// Preserves each item's identity (id/listId/listType); the ops are encrypted
// under the shared base's current epoch via prepareListAppendOperation.
export async function seedSharedBase (ctx, items) {
    if (!ctx.autobase) return
    const view = { epochKey: ctx.epochKey, membershipState: ctx.membershipState }
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!item) continue
        const op = createListOperation('add', item, { listId: item.listId, listType: item.listType })
        if (!op) continue
        await ctx.autobase.append(prepareListAppendOperation(op, view))
    }
    await ctx.autobase.update()
}

// --- Additive join (joiner becomes a writer; personal base untouched) ---------
let _sharedJoinTempSwarms = new Set()

// Blind-pairing join of a shared base into a NEW ctx, WITHOUT replacing the
// personal base (the additive counterpart of network.mjs joinViaInvite). Returns
// { ctx, baseKeyHex } on success. The caller adds the personal-registry entry.
export async function joinSharedBaseViaInvite (createBaseContext, { invite, storageDir, bootstrap = swarmBootstrap, joinSwarm = true, timeoutMs = 120000 } = {}) {
    const normalizedInvite = normalizeInviteCode(invite)
    if (!normalizedInvite) throw new Error('Invite is empty or invalid')
    if (!storageDir) throw new Error('joinSharedBaseViaInvite requires a storageDir')

    const inviteInfo = BlindPairing.decodeInvite(z32.decode(normalizedInvite))
    if (!inviteInfo?.discoveryKey) throw new Error('Invite does not carry a base discovery key')

    const ctx = createBaseContext({ role: 'shared' })
    ctx.store = new Corestore(storageDir)
    await ctx.store.ready()

    // Derive (and record) the scoped writer the host will authorize; the same
    // key is reconstructed on every reopen via loadSharedScopedWriter.
    const joinedWriter = await deriveSharedWriter(ctx.store, inviteInfo.discoveryKey)
    await recordSharedScopedWriter(ctx.store, joinedWriter.scopeName)

    const joinEpochEncryptionKeyPair = createEpochEncryptionKeyPair()
    ctx.epochEncryptionKeyPair = joinEpochEncryptionKeyPair

    const tempSwarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
    const tempPairing = new BlindPairing(tempSwarm)
    _sharedJoinTempSwarms.add(tempSwarm)

    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Shared-base pairing timed out')), timeoutMs)
            tempPairing.addCandidate({
                invite: z32.decode(normalizedInvite),
                userData: Buffer.from(JSON.stringify({
                    version: 1,
                    writerKey: joinedWriter.writerKey.toString('hex'),
                    epochPublicKey: epochPublicKeyHex(joinEpochEncryptionKeyPair),
                })),
                onadd: async (paired) => { clearTimeout(timer); resolve(paired) },
            })
        })

        if (!result?.key || !result?.encryptionKey) throw new Error('Pairing returned incomplete credentials')
        const inviteEpoch = decodeInviteEpochData(result.data)
        if (!inviteEpoch) throw new Error('Pairing returned no epoch key')
        ctx.setEpochKey(inviteEpoch.epochKey)

        // Open the shared base on the joined credentials, reusing the Corestore
        // (so the scoped writer matches) and pinning the scoped keyPair.
        await openSharedBase(ctx, {
            baseKey: result.key,
            encryptionKey: result.encryptionKey,
            storageDir,
            store: ctx.store,
            keyPair: joinedWriter.keyPair,
            bootstrap,
            joinSwarm,
        })
        persistSharedSecrets(ctx) // epoch key + our epoch-encryption keypair (no owner)

        // Replicate over the temp swarm's live connection so data flows before
        // the main swarm finds the host over the DHT.
        for (const conn of tempSwarm.connections) {
            if (conn.destroyed || conn.closed) continue
            try { ctx.autobase.replicate(conn) } catch (e) { logger.log('[ERROR] shared join temp replicate:', e) }
        }

        // Poll for write access (the host authorizes our writer during pairing,
        // but the membership op must linearize through our base first).
        const deadline = Date.now() + timeoutMs
        while (!ctx.autobase.writable && Date.now() < deadline) {
            try { await ctx.autobase.update() } catch (_) {}
            await new Promise((r) => setTimeout(r, 250))
        }
        await rebuildSharedListFromView(ctx)
        return { ctx, baseKeyHex: ctx.baseId, writable: ctx.autobase.writable }
    } finally {
        _sharedJoinTempSwarms.delete(tempSwarm)
        try { await tempPairing.close() } catch (_) {}
        try { await tempSwarm.destroy() } catch (_) {}
    }
}
