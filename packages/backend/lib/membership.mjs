import { keyPair, sign, verify } from 'hypercore-crypto'
import { epochKeyHashHex, normalizeEpochGrant } from './key-epochs.mjs'

export const MEMBERSHIP_RECORD_TYPE = 'membership'
export const MEMBERSHIP_RECORD_VERSION = 1
export const OWNER_BOOTSTRAP_ACTION = 'bootstrap-owner'
export const ADD_WRITER_ACTION = 'add-writer'
export const REMOVE_WRITER_ACTION = 'remove-writer'
export const OWNER_AUTHORITY_SECRET_BYTES = 64
export const OWNER_AUTHORITY_PUBLIC_BYTES = 32
export const WRITER_KEY_BYTES = 32
export const EPOCH_PUBLIC_KEY_BYTES = 32
export const EPOCH_KEY_HASH_BYTES = 32
export const SIGNATURE_BYTES = 64

const HEX = /^[0-9a-f]+$/i

export function createMembershipState() {
    return {
        ownerAuthorityKey: null,
        ownerWriterKey: null,
        highestSequence: 0,
        currentEpoch: 0,
        currentEpochKeyHash: null,
        writers: new Set(),
        writerEpochPublicKeys: new Map(),
        removedWriters: new Map(),
    }
}

export function cloneMembershipState(state) {
    return {
        ownerAuthorityKey: state?.ownerAuthorityKey || null,
        ownerWriterKey: state?.ownerWriterKey || null,
        highestSequence: Number(state?.highestSequence) || 0,
        currentEpoch: Number(state?.currentEpoch) || 0,
        currentEpochKeyHash: state?.currentEpochKeyHash || null,
        writers: new Set(state?.writers || []),
        writerEpochPublicKeys: new Map(state?.writerEpochPublicKeys || []),
        removedWriters: new Map(state?.removedWriters || []),
    }
}

export function createOwnerAuthorityKeyPair(secretKey = null) {
    if (!secretKey) return keyPair()

    const normalized = normalizeBuffer(secretKey, OWNER_AUTHORITY_SECRET_BYTES)
    if (!normalized) return null

    const derived = keyPair(normalized.subarray(0, 32))
    return bufferToHex(derived.secretKey) === bufferToHex(normalized) ? derived : null
}

export function ownerAuthorityPublicKeyHex(ownerAuthorityKeyPair) {
    return normalizeHex(ownerAuthorityKeyPair?.publicKey, OWNER_AUTHORITY_PUBLIC_BYTES)
}

export function ownerAuthoritySecretKeyHex(ownerAuthorityKeyPair) {
    return normalizeHex(ownerAuthorityKeyPair?.secretKey, OWNER_AUTHORITY_SECRET_BYTES)
}

export function ownerAuthorityMatchesState(ownerAuthorityKeyPair, state) {
    const publicKey = ownerAuthorityPublicKeyHex(ownerAuthorityKeyPair)
    return !!publicKey && !!state?.ownerAuthorityKey && state.ownerAuthorityKey === publicKey
}

export function canCreateMembershipInvite(state, ownerAuthorityKeyPair) {
    return ownerAuthorityMatchesState(ownerAuthorityKeyPair, state)
}

export function nextMembershipSequence(state) {
    return Math.max(0, Number(state?.highestSequence) || 0) + 1
}

// Project the membership state into a roster for the frontend: the active
// writers (owner first), which one is this device, the current epoch, and
// whether the caller can administer (holds owner authority). Writer keys are
// opaque public identifiers, not secrets.
export function buildMembershipRoster(state, { localWriterKey = null, hasOwnerAuthority = false } = {}) {
    const ownerWriterKey = state?.ownerWriterKey || null
    const selfKey = typeof localWriterKey === 'string' ? localWriterKey : null

    const writers = [...(state?.writers || [])].map((writerKey) => ({
        writerKey,
        isOwner: writerKey === ownerWriterKey,
        isSelf: !!selfKey && writerKey === selfKey,
    }))
    writers.sort((a, b) => {
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1
        return a.writerKey.localeCompare(b.writerKey)
    })

    return {
        currentEpoch: Number(state?.currentEpoch) || 0,
        ownerWriterKey,
        canAdminister: !!hasOwnerAuthority,
        writers,
    }
}

export function createOwnerBootstrapRecord({
    ownerAuthorityKeyPair,
    writerKey,
    baseKey,
    epochPublicKey = null,
    epochKey = null,
    epoch = 1,
    createdAt = Date.now(),
}) {
    return createSignedMembershipRecord({
        action: OWNER_BOOTSTRAP_ACTION,
        ownerAuthorityKeyPair,
        writerKey,
        baseKey,
        epochPublicKey,
        epochKey,
        epoch,
        sequence: 1,
        createdAt,
    })
}

export function createAddWriterMembershipRecord({
    ownerAuthorityKeyPair,
    writerKey,
    baseKey,
    sequence,
    epochPublicKey = null,
    createdAt = Date.now(),
}) {
    return createSignedMembershipRecord({
        action: ADD_WRITER_ACTION,
        ownerAuthorityKeyPair,
        writerKey,
        baseKey,
        sequence,
        epochPublicKey,
        createdAt,
    })
}

export function createRemoveWriterMembershipRecord({
    ownerAuthorityKeyPair,
    writerKey,
    baseKey,
    sequence,
    previousEpoch,
    epoch,
    epochKey,
    epochGrants,
    createdAt = Date.now(),
}) {
    return createSignedMembershipRecord({
        action: REMOVE_WRITER_ACTION,
        ownerAuthorityKeyPair,
        writerKey,
        baseKey,
        sequence,
        previousEpoch,
        epoch,
        epochKey,
        epochGrants,
        createdAt,
    })
}

export function createSignedMembershipRecord({
    action,
    ownerAuthorityKeyPair,
    writerKey,
    baseKey,
    sequence,
    epochPublicKey = null,
    previousEpoch = null,
    epoch = null,
    epochKey = null,
    epochGrants = null,
    createdAt = Date.now(),
}) {
    const body = normalizeMembershipBody({
        type: MEMBERSHIP_RECORD_TYPE,
        version: MEMBERSHIP_RECORD_VERSION,
        action,
        baseKey,
        ownerAuthorityKey: ownerAuthorityPublicKeyHex(ownerAuthorityKeyPair),
        writerKey,
        sequence,
        epochPublicKey,
        previousEpoch,
        epoch,
        epochKeyHash: epochKeyHashHex(epochKey),
        epochGrants,
        createdAt,
    })
    if (!body) throw new Error('Invalid membership record body')

    const secretKey = normalizeBuffer(ownerAuthorityKeyPair?.secretKey, OWNER_AUTHORITY_SECRET_BYTES)
    if (!secretKey) throw new Error('Invalid owner authority key pair')

    return {
        ...body,
        signature: bufferToHex(sign(Buffer.from(membershipSigningPayload(body)), secretKey)),
    }
}

export function isMembershipRecord(value) {
    return value?.type === MEMBERSHIP_RECORD_TYPE
}

export function reduceMembershipOperation(record, state = createMembershipState(), options = {}) {
    const current = cloneMembershipState(state)
    const body = normalizeMembershipBody(record)
    if (!body) return rejected('malformed', current)

    const expectedBaseKey = normalizeHex(options.baseKey, WRITER_KEY_BYTES)
    if (expectedBaseKey && body.baseKey !== expectedBaseKey) {
        return rejected('wrong-base', current)
    }

    const signature = normalizeHex(record.signature, SIGNATURE_BYTES)
    if (!signature) return rejected('unsigned', current)

    const verified = verify(
        Buffer.from(membershipSigningPayload(body)),
        Buffer.from(signature, 'hex'),
        Buffer.from(body.ownerAuthorityKey, 'hex'),
    )
    if (!verified) return rejected('bad-signature', current)

    if (body.action === OWNER_BOOTSTRAP_ACTION) {
        if (current.ownerAuthorityKey) return rejected('owner-exists', current)
        if (body.sequence !== 1) return rejected('invalid-sequence', current)

        const next = cloneMembershipState(current)
        next.ownerAuthorityKey = body.ownerAuthorityKey
        next.ownerWriterKey = body.writerKey
        next.highestSequence = body.sequence
        next.currentEpoch = body.epoch || 1
        next.currentEpochKeyHash = body.epochKeyHash || null
        next.writers.add(body.writerKey)
        if (body.epochPublicKey) next.writerEpochPublicKeys.set(body.writerKey, body.epochPublicKey)
        return accepted(next, null)
    }

    if (body.action === ADD_WRITER_ACTION) {
        if (!current.ownerAuthorityKey) return rejected('missing-owner', current)
        if (body.ownerAuthorityKey !== current.ownerAuthorityKey) return rejected('wrong-owner', current)
        if (body.sequence <= current.highestSequence) return rejected('replay', current)
        if (current.removedWriters.has(body.writerKey)) return rejected('removed-writer', current)

        const next = cloneMembershipState(current)
        next.highestSequence = body.sequence
        const alreadyKnown = next.writers.has(body.writerKey)
        next.writers.add(body.writerKey)
        if (body.epochPublicKey) next.writerEpochPublicKeys.set(body.writerKey, body.epochPublicKey)
        return accepted(next, alreadyKnown ? null : { addWriterKey: body.writerKey })
    }

    if (body.action === REMOVE_WRITER_ACTION) {
        if (!current.ownerAuthorityKey) return rejected('missing-owner', current)
        if (body.ownerAuthorityKey !== current.ownerAuthorityKey) return rejected('wrong-owner', current)
        if (body.sequence <= current.highestSequence) return rejected('replay', current)
        if (!current.writers.has(body.writerKey)) return rejected('unknown-writer', current)
        if (body.writerKey === current.ownerWriterKey) return rejected('cannot-remove-owner', current)
        if (current.writers.size <= 1) return rejected('last-writer', current)
        if (body.previousEpoch !== current.currentEpoch) return rejected('wrong-previous-epoch', current)
        if (body.epoch !== current.currentEpoch + 1) return rejected('invalid-epoch', current)
        if (!body.epochKeyHash) return rejected('missing-epoch-key-hash', current)

        const remainingWriters = [...current.writers].filter((writerKey) => writerKey !== body.writerKey)
        const grantWriterKeys = new Set(body.epochGrants.map((grant) => grant.writerKey))
        for (const writerKey of remainingWriters) {
            if (!grantWriterKeys.has(writerKey)) return rejected('missing-epoch-grant', current)
        }

        const next = cloneMembershipState(current)
        next.highestSequence = body.sequence
        next.currentEpoch = body.epoch
        next.currentEpochKeyHash = body.epochKeyHash
        next.writers.delete(body.writerKey)
        next.writerEpochPublicKeys.delete(body.writerKey)
        next.removedWriters.set(body.writerKey, {
            epoch: body.epoch,
            removedAt: body.createdAt,
        })
        return accepted(next, {
            removeWriterKey: body.writerKey,
            audit: {
                type: 'member-removed',
                writerKey: body.writerKey,
                epoch: body.epoch,
                createdAt: body.createdAt,
            },
            epochGrants: body.epochGrants,
            epochKeyHash: body.epochKeyHash,
        })
    }

    return rejected('unknown-action', current)
}

// Fold an ordered list of persisted membership records back into a membership
// state. Used to rebuild the in-memory state after a restart, because the
// module-global membershipState is not itself durable — only the records
// persisted in the Autobase view are. Rejected records leave the state
// unchanged, exactly as they do during live apply, so the rebuilt state matches
// what live reduction produced (owner key, writer set, and sequence
// high-water mark all survive a restart).
export function reduceMembershipLog(records, options = {}) {
    let state = createMembershipState()
    if (!Array.isArray(records)) return state
    for (const record of records) {
        state = reduceMembershipOperation(record, state, options).state
    }
    return state
}

function accepted(state, effect) {
    return {
        ok: true,
        state,
        effect,
        reason: null,
    }
}

function rejected(reason, state) {
    return {
        ok: false,
        state,
        effect: null,
        reason,
    }
}

function normalizeMembershipBody(raw) {
    const action = raw?.action
    if (
        action !== OWNER_BOOTSTRAP_ACTION &&
        action !== ADD_WRITER_ACTION &&
        action !== REMOVE_WRITER_ACTION
    ) return null

    const baseKey = normalizeHex(raw?.baseKey, WRITER_KEY_BYTES)
    const ownerAuthorityKey = normalizeHex(raw?.ownerAuthorityKey, OWNER_AUTHORITY_PUBLIC_BYTES)
    const writerKey = normalizeHex(raw?.writerKey, WRITER_KEY_BYTES)
    const epochPublicKey = normalizeHex(raw?.epochPublicKey, EPOCH_PUBLIC_KEY_BYTES)
    const epochKeyHash = normalizeHex(raw?.epochKeyHash, EPOCH_KEY_HASH_BYTES)
    const sequence = Number(raw?.sequence)
    const createdAt = Number(raw?.createdAt)
    const previousEpoch = normalizeOptionalEpoch(raw?.previousEpoch)
    const epoch = normalizeOptionalEpoch(raw?.epoch)
    const epochGrants = normalizeEpochGrants(raw?.epochGrants)

    if (raw?.type !== MEMBERSHIP_RECORD_TYPE) return null
    if (Number(raw?.version) !== MEMBERSHIP_RECORD_VERSION) return null
    if (!baseKey || !ownerAuthorityKey || !writerKey) return null
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null
    if (raw?.epochPublicKey != null && !epochPublicKey) return null

    if (action === OWNER_BOOTSTRAP_ACTION) {
        if (raw?.epoch != null && !epoch) return null
        if (raw?.epochKeyHash != null && !epochKeyHash) return null
    }

    if (action === ADD_WRITER_ACTION) {
        if (raw?.epoch != null || raw?.previousEpoch != null || raw?.epochKeyHash != null || raw?.epochGrants != null) return null
    }

    if (action === REMOVE_WRITER_ACTION) {
        if (!previousEpoch || !epoch || !epochKeyHash) return null
        if (!epochGrants || epochGrants.length === 0) return null
    }

    const body = {
        type: MEMBERSHIP_RECORD_TYPE,
        version: MEMBERSHIP_RECORD_VERSION,
        action,
        baseKey,
        ownerAuthorityKey,
        writerKey,
        sequence,
        createdAt,
    }

    if (epochPublicKey) body.epochPublicKey = epochPublicKey
    if (previousEpoch) body.previousEpoch = previousEpoch
    if (epoch) body.epoch = epoch
    if (epochKeyHash) body.epochKeyHash = epochKeyHash
    if (epochGrants) body.epochGrants = epochGrants

    return body
}

function membershipSigningPayload(body) {
    const payload = {
        type: body.type,
        version: body.version,
        action: body.action,
        baseKey: body.baseKey,
        ownerAuthorityKey: body.ownerAuthorityKey,
        writerKey: body.writerKey,
        sequence: body.sequence,
        epochPublicKey: body.epochPublicKey,
        previousEpoch: body.previousEpoch,
        epoch: body.epoch,
        epochKeyHash: body.epochKeyHash,
        epochGrants: body.epochGrants,
        createdAt: body.createdAt,
    }

    for (const key of Object.keys(payload)) {
        if (payload[key] == null) delete payload[key]
    }

    return JSON.stringify(payload)
}

function normalizeHex(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return bufferToHex(value, bytes)
    }
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return HEX.test(hex) && hex.length === bytes * 2 ? hex : null
}

function normalizeBuffer(value, bytes) {
    const hex = normalizeHex(value, bytes)
    return hex ? Buffer.from(hex, 'hex') : null
}

function normalizeOptionalEpoch(value) {
    if (value == null) return null
    const epoch = Number(value)
    return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null
}

function normalizeEpochGrants(value) {
    if (value == null) return null
    if (!Array.isArray(value)) return null

    const grants = []
    const seen = new Set()
    for (const entry of value) {
        const grant = normalizeEpochGrant(entry)
        if (!grant || seen.has(grant.writerKey)) return null
        seen.add(grant.writerKey)
        grants.push(grant)
    }

    return grants.sort((a, b) => a.writerKey.localeCompare(b.writerKey))
}

function bufferToHex(value, bytes = null) {
    if (!value) return null
    const buffer = Buffer.from(value)
    if (bytes != null && buffer.length !== bytes) return null
    return buffer.toString('hex')
}
