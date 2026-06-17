// Owner-signed board configuration record (rigor mode + states + properties +
// rules + automations). Mirrors lib/membership.mjs: the record is signed with
// the board creator's owner-authority key and verified against it, so no peer
// can change the board's rules without the creator's signature. Default config
// (rigor ON) applies whenever no record has been seen.

import { sign, verify } from 'hypercore-crypto'
import { normalizeBoardConfig } from './board.mjs'

export const BOARD_CONFIG_RECORD_TYPE = 'board-config'
export const BOARD_CONFIG_RECORD_VERSION = 1

const OWNER_AUTHORITY_PUBLIC_BYTES = 32
const OWNER_AUTHORITY_SECRET_BYTES = 64
const BASE_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const HEX = /^[0-9a-f]+$/i

export function createBoardConfigState() {
    return {
        highestSequence: 0,
        updatedAt: 0,
        config: normalizeBoardConfig(null), // defaults => rigor ON
    }
}

export function cloneBoardConfigState(state) {
    return {
        highestSequence: Number(state?.highestSequence) || 0,
        updatedAt: Number(state?.updatedAt) || 0,
        config: normalizeBoardConfig(state?.config),
    }
}

export function nextBoardConfigSequence(state) {
    return Math.max(0, Number(state?.highestSequence) || 0) + 1
}

export function isBoardConfigRecord(value) {
    return value?.type === BOARD_CONFIG_RECORD_TYPE
}

export function createBoardConfigRecord({
    ownerAuthorityKeyPair,
    baseKey,
    config,
    sequence,
    createdAt = Date.now(),
}) {
    const body = normalizeBoardConfigBody({
        type: BOARD_CONFIG_RECORD_TYPE,
        version: BOARD_CONFIG_RECORD_VERSION,
        baseKey,
        ownerAuthorityKey: normalizeHex(ownerAuthorityKeyPair?.publicKey, OWNER_AUTHORITY_PUBLIC_BYTES),
        sequence,
        createdAt,
        config,
    })
    if (!body) throw new Error('Invalid board-config record body')

    const secretKey = normalizeBuffer(ownerAuthorityKeyPair?.secretKey, OWNER_AUTHORITY_SECRET_BYTES)
    if (!secretKey) throw new Error('Invalid owner authority key pair')

    return {
        ...body,
        signature: bufferToHex(sign(Buffer.from(boardConfigSigningPayload(body)), secretKey)),
    }
}

export function reduceBoardConfigOperation(record, state = createBoardConfigState(), options = {}) {
    const current = cloneBoardConfigState(state)
    const body = normalizeBoardConfigBody(record)
    if (!body) return rejected('malformed', current)

    const expectedBaseKey = normalizeHex(options.baseKey, BASE_KEY_BYTES)
    if (expectedBaseKey && body.baseKey !== expectedBaseKey) return rejected('wrong-base', current)

    const signature = normalizeHex(record.signature, SIGNATURE_BYTES)
    if (!signature) return rejected('unsigned', current)

    const verified = verify(
        Buffer.from(boardConfigSigningPayload(body)),
        Buffer.from(signature, 'hex'),
        Buffer.from(body.ownerAuthorityKey, 'hex'),
    )
    if (!verified) return rejected('bad-signature', current)

    // Only the board creator's authority may change the config.
    const expectedOwner = normalizeHex(options.ownerAuthorityKey, OWNER_AUTHORITY_PUBLIC_BYTES)
    if (expectedOwner && body.ownerAuthorityKey !== expectedOwner) return rejected('wrong-owner', current)

    if (body.sequence <= current.highestSequence) return rejected('replay', current)

    const next = cloneBoardConfigState(current)
    next.highestSequence = body.sequence
    next.updatedAt = body.createdAt
    next.config = normalizeBoardConfig(body.config)
    return accepted(next)
}

// Fold persisted board-config records back into a state after a restart — the
// in-memory state is not durable, only the records in the Autobase view are.
export function reduceBoardConfigLog(records, options = {}) {
    let state = createBoardConfigState()
    if (!Array.isArray(records)) return state
    for (const record of records) {
        state = reduceBoardConfigOperation(record, state, options).state
    }
    return state
}

function accepted(state) {
    return { ok: true, state, reason: null }
}

function rejected(reason, state) {
    return { ok: false, state, reason }
}

function normalizeBoardConfigBody(raw) {
    if (raw?.type !== BOARD_CONFIG_RECORD_TYPE) return null
    if (Number(raw?.version) !== BOARD_CONFIG_RECORD_VERSION) return null

    const baseKey = normalizeHex(raw?.baseKey, BASE_KEY_BYTES)
    const ownerAuthorityKey = normalizeHex(raw?.ownerAuthorityKey, OWNER_AUTHORITY_PUBLIC_BYTES)
    const sequence = Number(raw?.sequence)
    const createdAt = Number(raw?.createdAt)

    if (!baseKey || !ownerAuthorityKey) return null
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null
    if (!raw?.config || typeof raw.config !== 'object') return null

    return {
        type: BOARD_CONFIG_RECORD_TYPE,
        version: BOARD_CONFIG_RECORD_VERSION,
        baseKey,
        ownerAuthorityKey,
        sequence,
        createdAt,
        config: normalizeBoardConfig(raw.config),
    }
}

// Deterministic signing payload. normalizeBoardConfig rebuilds the config with a
// fixed top-level key order on both signer and verifier, and the JSON round-trip
// preserves nested order, so signer and verifier serialize identical strings.
function boardConfigSigningPayload(body) {
    return JSON.stringify({
        type: body.type,
        version: body.version,
        baseKey: body.baseKey,
        ownerAuthorityKey: body.ownerAuthorityKey,
        sequence: body.sequence,
        createdAt: body.createdAt,
        config: body.config,
    })
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

function bufferToHex(value, bytes = null) {
    if (!value) return null
    const buffer = Buffer.from(value)
    if (bytes != null && buffer.length !== bytes) return null
    return buffer.toString('hex')
}
