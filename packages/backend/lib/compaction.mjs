// Owner-signed history compaction ("flatten the history for everybody").
//
// WHY
// Joining a long-lived project is O(entire history). A guest must replay every
// node through apply() before Autobase settles and `writable` can flip, and an
// invite carries exactly ONE epoch key — so on a base that has rotated N times,
// every op predating the current epoch costs a failed AEAD attempt per held key
// before being skipped. The 2026-07-29 Nothing Phone join spent ~5 minutes at
// 210% CPU doing exactly this, on a base with seven epochs.
//
// A compaction barrier says: "as of this clock, the authoritative state is the
// snapshot I just wrote; everything at or below it is superseded." apply() then
// skips those nodes WITHOUT decrypting them.
//
// THE CLOCK, NOT CAUSAL POSITION
// Coverage is `node.length <= clock[writerKey]`, taken from `autobase.system.heads`
// at mint time ([{ key, length }], the same units apply sees on each node —
// `{ from: writer.core, length, value }`). It is deliberately NOT "everything
// linearized before the barrier": a writer that had not yet seen the barrier
// produces nodes OUTSIDE its clock, so its writes are still admitted. That
// preserves the acceptHeldEpochOps fix (2026-07-28), which exists precisely to
// stop discarding an innocent member's pre-rotation writes.
//
// WHY THIS CANNOT FORK AN OLDER PEER
// normalizeListOperation() returns null for any type outside LIST_OPERATION_TYPES,
// and apply continues on null — so a peer on an older build drops the barrier
// record and simply reduces everything, arriving at the same state by doing more
// work. That holds on ONE condition, which is the whole safety argument:
//
//     the snapshot must be exactly the reduction of what the barrier supersedes.
//
// `snapshotDigest` is how a peer checks that before honouring a barrier. A
// barrier whose snapshot did not land (rekey.mjs can commit a removal and still
// fail to write its snapshot) must never suppress history — that would be data
// loss, not compaction.
import { hash, sign, verify } from 'hypercore-crypto'

export const COMPACTION_RECORD_TYPE = 'compaction'
export const COMPACTION_RECORD_VERSION = 1
export const OWNER_AUTHORITY_SECRET_BYTES = 64
export const WRITER_KEY_BYTES = 32
export const SIGNATURE_BYTES = 64

const COMPACTION_DIGEST_NAMESPACE = Buffer.from('listam/compaction/snapshot/1')
const HEX = /^[0-9a-f]+$/i

export function createCompactionState() {
    return {
        // Highest barrier this timeline has committed. 0 = never compacted.
        sequence: 0,
        epoch: 0,
        snapshotDigest: null,
        // writerKeyHex -> highest superseded length
        clock: new Map(),
        // Honouring is a LOCAL verdict, not part of the signed record: a peer
        // only skips history once it has confirmed it holds the snapshot that
        // replaces it. Until then the barrier is known but inert.
        honoured: false,
    }
}

export function cloneCompactionState(state) {
    return {
        sequence: Number(state?.sequence) || 0,
        epoch: Number(state?.epoch) || 0,
        snapshotDigest: state?.snapshotDigest || null,
        clock: new Map(state?.clock || []),
        honoured: !!state?.honoured,
    }
}

// A stable digest of the item set a snapshot carries. Order-independent by
// construction (ids are sorted), so two peers that reduced the same history
// agree on it regardless of linearization order.
export function snapshotDigestHex(items) {
    if (!Array.isArray(items)) return null
    const canonical = items
        .map((item) => {
            if (!item || typeof item !== 'object') return null
            return JSON.stringify([
                String(item.id ?? ''),
                String(item.listId ?? ''),
                String(item.listType ?? ''),
                String(item.text ?? ''),
                item.isDone === true,
                Number(item.updatedAt) || 0,
            ])
        })
        .filter((entry) => entry !== null)
        .sort()
    return hash([COMPACTION_DIGEST_NAMESPACE, Buffer.from(JSON.stringify(canonical))]).toString('hex')
}

// Group a full reduction into ONE snapshot group per list bucket.
//
// This is not a detail — it is the difference between compaction and data loss.
// The reducer keys its buckets by listId (list-reducer.mjs), so a `list`
// operation replaces exactly ONE bucket. rekey.mjs's existing epoch snapshot
// writes a single untargeted list op, which lands in the DEFAULT bucket; that is
// harmless there, because every peer already holds the rest. A barrier that
// suppressed history behind such a snapshot would wipe every named list, board
// ticket, registry meta-item and label on the peer that honoured it.
//
// So the snapshot a barrier certifies is one group per bucket, covering the
// whole reduction — `allItems()`, never `items()`.
export function buildCompactionSnapshot(allItems) {
    const byList = new Map()
    for (const item of (Array.isArray(allItems) ? allItems : [])) {
        if (!item || typeof item !== 'object') continue
        const listId = item.listId ?? null
        const key = String(listId)
        if (!byList.has(key)) byList.set(key, { listId, listType: item.listType ?? null, items: [] })
        byList.get(key).items.push(item)
    }
    return [...byList.values()]
}

// `heads` is autobase.system.heads: [{ key: Buffer, length: Number }].
export function clockFromHeads(heads) {
    const clock = []
    if (!Array.isArray(heads)) return clock
    for (const head of heads) {
        const writerKey = normalizeHex(head?.key, WRITER_KEY_BYTES)
        const length = Number(head?.length)
        if (!writerKey || !Number.isSafeInteger(length) || length < 0) continue
        clock.push({ writerKey, length })
    }
    // Deterministic order so the signed payload is reproducible.
    return clock.sort((a, b) => a.writerKey.localeCompare(b.writerKey))
}

export function createCompactionRecord({
    ownerAuthorityKeyPair,
    baseKey,
    sequence,
    epoch,
    snapshotDigest,
    clock,
    createdAt = Date.now(),
}) {
    const body = normalizeCompactionBody({
        type: COMPACTION_RECORD_TYPE,
        version: COMPACTION_RECORD_VERSION,
        baseKey,
        ownerAuthorityKey: publicKeyHex(ownerAuthorityKeyPair),
        sequence,
        epoch,
        snapshotDigest,
        clock,
        createdAt,
    })
    if (!body) throw new Error('Invalid compaction record body')

    const secretKey = normalizeBuffer(ownerAuthorityKeyPair?.secretKey, OWNER_AUTHORITY_SECRET_BYTES)
    if (!secretKey) throw new Error('Invalid owner authority key pair')

    return {
        ...body,
        signature: bufferToHex(sign(Buffer.from(compactionSigningPayload(body)), secretKey)),
    }
}

export function isCompactionRecord(value) {
    return value?.type === COMPACTION_RECORD_TYPE
}

// `options.ownerAuthorityKey` is the owner from the committed MEMBERSHIP state —
// compaction never establishes authority of its own, it only ever spends the
// authority membership already recognizes.
export function reduceCompactionOperation(record, state = createCompactionState(), options = {}) {
    const current = cloneCompactionState(state)
    const body = normalizeCompactionBody(record)
    if (!body) return rejected('malformed', current)

    const expectedBaseKey = normalizeHex(options.baseKey, WRITER_KEY_BYTES)
    if (expectedBaseKey && body.baseKey !== expectedBaseKey) return rejected('wrong-base', current)

    const owner = normalizeHex(options.ownerAuthorityKey, WRITER_KEY_BYTES)
    if (!owner) return rejected('missing-owner', current)
    if (body.ownerAuthorityKey !== owner) return rejected('wrong-owner', current)

    const signature = normalizeHex(record.signature, SIGNATURE_BYTES)
    if (!signature) return rejected('unsigned', current)
    const verified = verify(
        Buffer.from(compactionSigningPayload(body)),
        Buffer.from(signature, 'hex'),
        Buffer.from(body.ownerAuthorityKey, 'hex'),
    )
    if (!verified) return rejected('bad-signature', current)

    if (body.sequence <= current.sequence) return rejected('replay', current)

    const next = cloneCompactionState(current)
    next.sequence = body.sequence
    next.epoch = body.epoch
    next.snapshotDigest = body.snapshotDigest
    next.clock = new Map(body.clock.map((entry) => [entry.writerKey, entry.length]))
    // A newly reduced barrier starts inert. Only confirmSnapshot() below, once
    // the reduction actually matches the digest the owner signed, lets it
    // suppress anything.
    next.honoured = false

    return { ok: true, reason: null, state: next }
}

// Adopt a barrier handed over out-of-band, at join time, before the base opens.
//
// This is the ONLY path that starts out honoured, and it has to be: a guest
// cannot confirm a snapshot it has not applied yet, and it cannot check the
// owner authority before replaying the very membership records the barrier
// exists to let it skip. Trust comes from the transport instead — the barrier
// rides the invite's signed additional data, exactly like the epoch key, and
// blind-pairing-core verifies that against the invite key pair before the guest
// ever sees it. An owner only mints one for a snapshot it has already written.
//
// Structure is still validated: a malformed payload yields null rather than a
// barrier that would silently suppress history.
export function seedCompactionBarrier(record) {
    const body = normalizeCompactionBody(record)
    if (!body) return null
    return {
        sequence: body.sequence,
        epoch: body.epoch,
        snapshotDigest: body.snapshotDigest,
        clock: new Map(body.clock.map((entry) => [entry.writerKey, entry.length])),
        honoured: true,
    }
}

// Fold a log of barrier records over a starting state. `initial` matters: a
// fresh guest is seeded with the barrier from its invite BEFORE the base opens,
// and the log it then replays must not be able to regress that — the reducer's
// sequence check does the work, so an older record in the log is a no-op.
export function reduceCompactionLog(records, initial = createCompactionState(), options = {}) {
    let state = cloneCompactionState(initial)
    for (const record of (Array.isArray(records) ? records : [])) {
        const result = reduceCompactionOperation(record, state, options)
        state = result.state
    }
    return state
}

// Promote a known barrier to honoured, once this device holds a reduction that
// matches the snapshot the owner signed. Returns the (possibly unchanged) state.
//
// This is the gate that makes a failed snapshot append harmless: rekey.mjs can
// commit a removal and still fail to write its re-encrypted snapshot, and a
// barrier whose snapshot never landed must never suppress the history it claims
// to replace.
export function confirmSnapshot(state, items) {
    if (!state?.snapshotDigest || state.honoured) return state
    if (snapshotDigestHex(items) !== state.snapshotDigest) return state
    const next = cloneCompactionState(state)
    next.honoured = true
    return next
}

// Is this apply node superseded by the committed barrier?
//
// `node` is what Autobase hands apply: { from: writer.core, length, value }.
// A writer absent from the clock is NOT covered — the heads a barrier is minted
// from are a frontier, so a dominated writer may be missing. Treating that as
// "not covered" only costs a little replay; the opposite would drop data.
export function isNodeCovered(node, state, writerKeyHex) {
    if (!state?.honoured) return false
    if (!writerKeyHex) return false
    const supersededThrough = state.clock?.get?.(writerKeyHex)
    if (!Number.isSafeInteger(supersededThrough)) return false
    const length = Number(node?.length)
    if (!Number.isSafeInteger(length)) return false
    return length <= supersededThrough
}

function rejected(reason, state) {
    return { ok: false, reason, state }
}

function compactionSigningPayload(body) {
    return JSON.stringify({
        type: body.type,
        version: body.version,
        baseKey: body.baseKey,
        ownerAuthorityKey: body.ownerAuthorityKey,
        sequence: body.sequence,
        epoch: body.epoch,
        snapshotDigest: body.snapshotDigest,
        clock: body.clock.map((entry) => [entry.writerKey, entry.length]),
        createdAt: body.createdAt,
    })
}

function normalizeCompactionBody(raw) {
    if (raw?.type !== COMPACTION_RECORD_TYPE) return null

    const version = Number(raw?.version)
    if (version !== COMPACTION_RECORD_VERSION) return null

    const baseKey = normalizeHex(raw?.baseKey, WRITER_KEY_BYTES)
    const ownerAuthorityKey = normalizeHex(raw?.ownerAuthorityKey, WRITER_KEY_BYTES)
    if (!baseKey || !ownerAuthorityKey) return null

    const sequence = Number(raw?.sequence)
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null

    const epoch = Number(raw?.epoch)
    if (!Number.isSafeInteger(epoch) || epoch <= 0) return null

    const snapshotDigest = normalizeHex(raw?.snapshotDigest, 32)
    if (!snapshotDigest) return null

    const clock = normalizeClock(raw?.clock)
    if (!clock) return null

    const createdAt = Number(raw?.createdAt)
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null

    return { type: COMPACTION_RECORD_TYPE, version, baseKey, ownerAuthorityKey, sequence, epoch, snapshotDigest, clock, createdAt }
}

function normalizeClock(value) {
    if (!Array.isArray(value)) return null
    const seen = new Set()
    const clock = []
    for (const entry of value) {
        const writerKey = normalizeHex(entry?.writerKey, WRITER_KEY_BYTES)
        const length = Number(entry?.length)
        if (!writerKey || seen.has(writerKey)) return null
        if (!Number.isSafeInteger(length) || length < 0) return null
        seen.add(writerKey)
        clock.push({ writerKey, length })
    }
    return clock.sort((a, b) => a.writerKey.localeCompare(b.writerKey))
}

function publicKeyHex(ownerAuthorityKeyPair) {
    return bufferToHex(ownerAuthorityKeyPair?.publicKey, WRITER_KEY_BYTES)
}

function normalizeHex(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return bufferToHex(value, bytes)
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return HEX.test(hex) && hex.length === bytes * 2 ? hex : null
}

function normalizeBuffer(value, bytes) {
    const hex = normalizeHex(value, bytes)
    return hex ? Buffer.from(hex, 'hex') : null
}

function bufferToHex(value, bytes = null) {
    if (!value) return null
    const buffer = Buffer.from(value)
    if (bytes != null && buffer.length !== bytes) return null
    return buffer.toString('hex')
}
