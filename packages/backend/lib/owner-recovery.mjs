// Owner authority recovery (Phase 4, deferred from Phase 3 finding C3).
//
// If the secure-stored owner authority key is lost (device wipe, secure-store
// reset, moving to a new device) the project becomes un-administrable: no
// further writers can be added or removed because every membership op must be
// owner-signed. The recovery path is a backup code the owner can store offline.
//
// An ed25519 secret key is `seed(32) || publicKey(32)`, and the owner authority
// keypair is derived from that seed (see createOwnerAuthorityKeyPair). So the
// recovery code is simply that 32-byte seed, z32-encoded. Re-deriving from it
// reproduces the exact keypair, and we can verify it against the owner public
// key the base already records in its membership log — so a code can be checked
// without trusting it, and the scheme works for bases created before this code
// existed (no new material has to have been stored at bootstrap).
//
// SECURITY: the recovery code *is* the owner authority secret. Anyone holding it
// can administer the project. It must be shown only to the owner, stored offline,
// and never logged (see logger redaction for 'ownerRecoveryCode').

import { keyPair } from 'hypercore-crypto'
import z32 from 'z32'

export const OWNER_RECOVERY_SEED_BYTES = 32
export const OWNER_AUTHORITY_SECRET_BYTES = 64
export const OWNER_AUTHORITY_PUBLIC_BYTES = 32

const HEX = /^[0-9a-f]+$/i

// The 32-byte recovery seed embedded in an owner authority secret key.
export function ownerRecoverySeedFromKeyPair(ownerAuthorityKeyPair) {
    const secret = normalizeBuffer(ownerAuthorityKeyPair?.secretKey, OWNER_AUTHORITY_SECRET_BYTES)
    return secret ? Buffer.from(secret.subarray(0, OWNER_RECOVERY_SEED_BYTES)) : null
}

export function formatOwnerRecoveryCode(seed) {
    const normalized = normalizeBuffer(seed, OWNER_RECOVERY_SEED_BYTES)
    return normalized ? z32.encode(normalized) : null
}

// The shareable recovery code for an owner authority keypair, or null if the
// keypair is missing/malformed.
export function ownerRecoveryCodeFromKeyPair(ownerAuthorityKeyPair) {
    const seed = ownerRecoverySeedFromKeyPair(ownerAuthorityKeyPair)
    return seed ? formatOwnerRecoveryCode(seed) : null
}

export function parseOwnerRecoveryCode(code) {
    if (typeof code !== 'string') return null
    const trimmed = code.trim().replace(/\s+/g, '')
    if (!trimmed) return null
    try {
        const decoded = Buffer.from(z32.decode(trimmed))
        return decoded.length === OWNER_RECOVERY_SEED_BYTES ? decoded : null
    } catch {
        return null
    }
}

export function deriveOwnerAuthorityFromSeed(seed) {
    const normalized = normalizeBuffer(seed, OWNER_RECOVERY_SEED_BYTES)
    if (!normalized) return null
    const derived = keyPair(normalized)
    if (derived?.publicKey?.length !== OWNER_AUTHORITY_PUBLIC_BYTES) return null
    if (derived?.secretKey?.length !== OWNER_AUTHORITY_SECRET_BYTES) return null
    return derived
}

// Recover the owner authority keypair from a recovery code, verifying it
// re-derives the public key the base records as its owner. Returns the keypair,
// or null if the code is malformed or belongs to a different owner/base.
export function recoverOwnerAuthorityFromCode(code, expectedOwnerPublicKeyHex) {
    const seed = parseOwnerRecoveryCode(code)
    if (!seed) return null

    const derived = deriveOwnerAuthorityFromSeed(seed)
    if (!derived) return null

    const expected = normalizeHex(expectedOwnerPublicKeyHex, OWNER_AUTHORITY_PUBLIC_BYTES)
    const actual = normalizeHex(derived.publicKey, OWNER_AUTHORITY_PUBLIC_BYTES)
    if (!expected || actual !== expected) return null

    return derived
}

function normalizeHex(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const buffer = Buffer.from(value)
        return buffer.length === bytes ? buffer.toString('hex') : null
    }
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return HEX.test(hex) && hex.length === bytes * 2 ? hex : null
}

function normalizeBuffer(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const buffer = Buffer.from(value)
        return buffer.length === bytes ? buffer : null
    }
    const hex = normalizeHex(value, bytes)
    return hex ? Buffer.from(hex, 'hex') : null
}
