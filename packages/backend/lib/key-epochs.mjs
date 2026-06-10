import { decrypt, encrypt, encryptionKeyPair, hash, randomBytes } from 'hypercore-crypto'
import sodium from 'sodium-universal'

export const EPOCH_KEY_BYTES = 32
export const EPOCH_KEY_HASH_BYTES = 32
export const EPOCH_PUBLIC_KEY_BYTES = 32
export const EPOCH_SECRET_KEY_BYTES = 32
export const EPOCH_NONCE_BYTES = 24
export const EPOCH_LIST_OP_TYPE = 'epoch-list-op'
export const EPOCH_LIST_OP_VERSION = 1

const EPOCH_KEY_HASH_NAMESPACE = Buffer.from('listam:epoch-key:v1')
const HEX = /^[0-9a-f]+$/i

export function createEpochEncryptionKeyPair(secretKey = null) {
    if (!secretKey) return encryptionKeyPair()

    const seed = normalizeBuffer(secretKey, EPOCH_SECRET_KEY_BYTES)
    return seed ? encryptionKeyPair(seed) : null
}

export function epochPublicKeyHex(keyPair) {
    return normalizeHex(keyPair?.publicKey, EPOCH_PUBLIC_KEY_BYTES)
}

export function epochSecretKeyHex(keyPair) {
    return normalizeHex(keyPair?.secretKey, EPOCH_SECRET_KEY_BYTES)
}

export function generateEpochKey() {
    return randomBytes(EPOCH_KEY_BYTES)
}

// Epoch bootstrap material carried in the invite's signed additional data.
//
// BlindPairing's confirm payload encodes exactly { key, encryptionKey,
// additional } — extra fields like epochKey passed to confirm() are silently
// dropped (the candidate would pair but never receive the list epoch key, so
// pre-join history would stay undecryptable). The supported channel is
// createInvite(key, { data }), which signs the data with the invite key pair;
// the candidate verifies the signature and surfaces it as `paired.data`.
export const INVITE_EPOCH_DATA_VERSION = 1

export function encodeInviteEpochData(epochKey, epoch) {
    const keyHex = normalizeHex(epochKey, EPOCH_KEY_BYTES)
    const epochNumber = Number(epoch)
    if (!keyHex || !Number.isInteger(epochNumber) || epochNumber <= 0) return null
    return Buffer.from(JSON.stringify({
        version: INVITE_EPOCH_DATA_VERSION,
        epochKey: keyHex,
        epoch: epochNumber,
    }))
}

export function decodeInviteEpochData(data) {
    if (!data) return null
    try {
        const parsed = JSON.parse(Buffer.from(data).toString('utf8'))
        if (Number(parsed?.version) !== INVITE_EPOCH_DATA_VERSION) return null
        const epochKey = normalizeBuffer(parsed.epochKey, EPOCH_KEY_BYTES)
        const epoch = Number(parsed.epoch)
        if (!epochKey || !Number.isInteger(epoch) || epoch <= 0) return null
        return { epochKey, epoch }
    } catch {
        return null
    }
}

export function epochKeyHashHex(epochKey) {
    const key = normalizeBuffer(epochKey, EPOCH_KEY_BYTES)
    return key ? hash([EPOCH_KEY_HASH_NAMESPACE, key]).toString('hex') : null
}

export function createEpochGrants({ epochKey, recipients }) {
    const key = normalizeBuffer(epochKey, EPOCH_KEY_BYTES)
    if (!key || !Array.isArray(recipients)) return []

    const uniqueRecipients = new Map()
    for (const recipient of recipients) {
        const writerKey = normalizeHex(recipient?.writerKey, EPOCH_PUBLIC_KEY_BYTES)
        const epochPublicKey = normalizeHex(recipient?.epochPublicKey, EPOCH_PUBLIC_KEY_BYTES)
        if (writerKey && epochPublicKey) uniqueRecipients.set(writerKey, epochPublicKey)
    }

    return [...uniqueRecipients.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([writerKey, epochPublicKey]) => ({
            writerKey,
            epochPublicKey,
            encryptedEpochKey: encrypt(key, Buffer.from(epochPublicKey, 'hex')).toString('hex'),
        }))
}

export function decryptEpochGrantForWriter(grants, writerKey, epochEncryptionKeyPair) {
    const normalizedWriterKey = normalizeHex(writerKey, EPOCH_PUBLIC_KEY_BYTES)
    const publicKey = normalizeBuffer(epochEncryptionKeyPair?.publicKey, EPOCH_PUBLIC_KEY_BYTES)
    const secretKey = normalizeBuffer(epochEncryptionKeyPair?.secretKey, EPOCH_SECRET_KEY_BYTES)
    if (!normalizedWriterKey || !publicKey || !secretKey || !Array.isArray(grants)) return null

    const grant = grants.find((entry) => normalizeHex(entry?.writerKey, EPOCH_PUBLIC_KEY_BYTES) === normalizedWriterKey)
    if (!grant) return null

    const encryptedEpochKey = normalizeCiphertext(grant.encryptedEpochKey)
    if (!encryptedEpochKey) return null

    const opened = decrypt(encryptedEpochKey, { publicKey, secretKey })
    return normalizeBuffer(opened, EPOCH_KEY_BYTES)
}

export function createEncryptedListOperation(operation, epochKey, epoch) {
    const key = normalizeBuffer(epochKey, EPOCH_KEY_BYTES)
    const epochNumber = normalizeEpoch(epoch)
    if (!key || !epochNumber) return null

    const nonce = randomBytes(EPOCH_NONCE_BYTES)
    const plaintext = Buffer.from(JSON.stringify(operation))
    const aad = encryptedListOperationAAD(epochNumber)
    const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)

    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        ciphertext,
        plaintext,
        aad,
        null,
        nonce,
        key,
    )

    return {
        type: EPOCH_LIST_OP_TYPE,
        version: EPOCH_LIST_OP_VERSION,
        epoch: epochNumber,
        nonce: nonce.toString('hex'),
        ciphertext: ciphertext.toString('hex'),
    }
}

export function decryptEncryptedListOperation(record, epochKey) {
    const body = normalizeEncryptedListOperation(record)
    const key = normalizeBuffer(epochKey, EPOCH_KEY_BYTES)
    if (!body || !key) return null

    const ciphertext = Buffer.from(body.ciphertext, 'hex')
    if (ciphertext.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) return null

    const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    let opened = false
    try {
        opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            plaintext,
            null,
            ciphertext,
            encryptedListOperationAAD(body.epoch),
            Buffer.from(body.nonce, 'hex'),
            key,
        )
    } catch {
        return null
    }
    if (!opened) return null

    try {
        return JSON.parse(plaintext.toString('utf8'))
    } catch {
        return null
    }
}

export function isEncryptedListOperation(value) {
    return value?.type === EPOCH_LIST_OP_TYPE
}

export function normalizeEpochGrant(raw) {
    const writerKey = normalizeHex(raw?.writerKey, EPOCH_PUBLIC_KEY_BYTES)
    const epochPublicKey = normalizeHex(raw?.epochPublicKey, EPOCH_PUBLIC_KEY_BYTES)
    const encryptedEpochKey = normalizeCiphertext(raw?.encryptedEpochKey)
    if (!writerKey || !epochPublicKey || !encryptedEpochKey) return null
    return {
        writerKey,
        epochPublicKey,
        encryptedEpochKey: encryptedEpochKey.toString('hex'),
    }
}

function normalizeEncryptedListOperation(raw) {
    if (raw?.type !== EPOCH_LIST_OP_TYPE) return null
    if (Number(raw?.version) !== EPOCH_LIST_OP_VERSION) return null

    const epoch = normalizeEpoch(raw?.epoch)
    const nonce = normalizeHex(raw?.nonce, EPOCH_NONCE_BYTES)
    const ciphertext = normalizeCiphertext(raw?.ciphertext)
    if (!epoch || !nonce || !ciphertext) return null

    return {
        type: EPOCH_LIST_OP_TYPE,
        version: EPOCH_LIST_OP_VERSION,
        epoch,
        nonce,
        ciphertext: ciphertext.toString('hex'),
    }
}

function encryptedListOperationAAD(epoch) {
    return Buffer.from(JSON.stringify({
        type: EPOCH_LIST_OP_TYPE,
        version: EPOCH_LIST_OP_VERSION,
        epoch,
    }))
}

function normalizeEpoch(value) {
    const epoch = Number(value)
    return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null
}

function normalizeCiphertext(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return HEX.test(hex) && hex.length > 0 && hex.length % 2 === 0 ? Buffer.from(hex, 'hex') : null
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
    const hex = normalizeHex(value, bytes)
    return hex ? Buffer.from(hex, 'hex') : null
}
