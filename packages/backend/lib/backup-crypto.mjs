// Password-based encryption for the backup/seed export files.
//
// Both the data backup and the seed backup go through the SAME path here — a
// file is never written as plaintext. We reuse the exact AEAD the list-epoch
// encryption already uses (XChaCha20-Poly1305, see key-epochs.mjs) and derive
// the key from the user's password with Argon2id (sodium's crypto_pwhash). The
// envelope is self-describing JSON (binary fields base64) so it round-trips
// across the desktop renderer and the React Native bridge without either side
// touching sodium — only this backend runtime does.
import sodium from 'sodium-universal'
import { randomBytes } from 'hypercore-crypto'
import b4a from 'b4a'

export const BACKUP_FORMAT = 'listam-export'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_KINDS = Object.freeze(['data', 'seed'])

const KEY_BYTES = 32
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES // 24
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES // 16

// Argon2id parameters. Memory is held at the "interactive" tier (~64 MiB) so an
// import runs fine on a phone, while ops are raised to the "moderate" tier for a
// stronger work factor. Both numbers are written into the envelope, so decrypt
// is driven by the file, not by these constants — older files keep opening even
// if we retune the defaults later.
const KDF_ALG = sodium.crypto_pwhash_ALG_ARGON2ID13
const KDF_OPSLIMIT = sodium.crypto_pwhash_OPSLIMIT_MODERATE
const KDF_MEMLIMIT = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE

function normalizeKind(kind) {
    return BACKUP_KINDS.includes(kind) ? kind : null
}

function deriveKey(password, salt, opslimit, memlimit, alg) {
    const key = b4a.alloc(KEY_BYTES)
    const passwordBuf = b4a.from(String(password), 'utf8')
    sodium.crypto_pwhash(key, passwordBuf, salt, opslimit, memlimit, alg)
    return key
}

// The kind is bound as additional authenticated data, so a seed file can never
// be silently opened as a data file (or vice versa) even with the right key.
function aadFor(kind) {
    return b4a.from(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, kind }), 'utf8')
}

// Encrypt a JSON-serializable object with a password. Returns the envelope as a
// string ready to write to a file. `createdAt` is supplied by the caller so the
// module stays free of ambient clock reads in test contexts.
export function encryptBackup(payload, password, kind, { createdAt = Date.now() } = {}) {
    const normalizedKind = normalizeKind(kind)
    if (!normalizedKind) throw new Error('Unknown backup kind')
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('A password is required to encrypt the backup')
    }

    const salt = randomBytes(SALT_BYTES)
    const key = deriveKey(password, salt, KDF_OPSLIMIT, KDF_MEMLIMIT, KDF_ALG)
    try {
        const nonce = randomBytes(NONCE_BYTES)
        const plaintext = b4a.from(JSON.stringify(payload), 'utf8')
        const ciphertext = b4a.alloc(plaintext.length + ABYTES)
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            ciphertext,
            plaintext,
            aadFor(normalizedKind),
            null,
            nonce,
            key,
        )
        return JSON.stringify({
            format: BACKUP_FORMAT,
            version: BACKUP_FORMAT_VERSION,
            kind: normalizedKind,
            createdAt,
            kdf: {
                algo: 'argon2id',
                ops: KDF_OPSLIMIT,
                mem: KDF_MEMLIMIT,
                salt: b4a.toString(salt, 'base64'),
            },
            cipher: 'xchacha20poly1305',
            nonce: b4a.toString(nonce, 'base64'),
            ct: b4a.toString(ciphertext, 'base64'),
        })
    } finally {
        sodium.sodium_memzero(key)
    }
}

// Decrypt an envelope string with a password. Returns { kind, createdAt,
// payload } on success. Throws a friendly Error on a wrong password, a tampered
// file, or a malformed envelope — the AEAD auth check is what distinguishes a
// bad password from a good one.
export function decryptBackup(fileText, password) {
    let env
    try {
        env = typeof fileText === 'string' ? JSON.parse(fileText) : fileText
    } catch {
        throw new Error('This file is not a valid Listam backup')
    }
    if (!env || typeof env !== 'object' || env.format !== BACKUP_FORMAT) {
        throw new Error('This file is not a valid Listam backup')
    }
    const kind = normalizeKind(env.kind)
    if (!kind) throw new Error('Unrecognized backup kind')
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('A password is required to open the backup')
    }

    const salt = b4a.from(String(env.kdf?.salt ?? ''), 'base64')
    if (salt.length !== SALT_BYTES) throw new Error('This backup file is corrupt')
    const opslimit = Number(env.kdf?.ops) || KDF_OPSLIMIT
    const memlimit = Number(env.kdf?.mem) || KDF_MEMLIMIT
    const nonce = b4a.from(String(env.nonce ?? ''), 'base64')
    const ciphertext = b4a.from(String(env.ct ?? ''), 'base64')
    if (nonce.length !== NONCE_BYTES || ciphertext.length < ABYTES) {
        throw new Error('This backup file is corrupt')
    }

    const key = deriveKey(password, salt, opslimit, memlimit, KDF_ALG)
    const plaintext = b4a.alloc(ciphertext.length - ABYTES)
    let opened = false
    try {
        opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            plaintext,
            null,
            ciphertext,
            aadFor(kind),
            nonce,
            key,
        )
    } catch {
        opened = false
    } finally {
        sodium.sodium_memzero(key)
    }
    if (opened === false) throw new Error('Wrong password, or this backup file has been tampered with')

    try {
        return { kind, createdAt: env.createdAt, payload: JSON.parse(b4a.toString(plaintext, 'utf8')) }
    } catch {
        throw new Error('This backup file is corrupt')
    }
}
