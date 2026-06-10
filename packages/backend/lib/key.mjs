import { logger } from './logger.mjs'
import { getBackendFs } from './platform-fs.mjs'
import {
    deleteBackendSecret,
    getBootSecretBuffer,
    persistBackendSecret,
    secretFingerprint,
} from './secrets.mjs'
import { createOwnerAuthorityKeyPair } from './membership.mjs'
import { createEpochEncryptionKeyPair } from './key-epochs.mjs'

const HEX = /^[0-9a-f]+$/i

// Read a 32-byte hex key from a legacy plaintext file, or null if absent/invalid.
function readLegacyKeyFile(filePath, bytes = 32) {
    try {
        const fs = getBackendFs()
        if (filePath && fs.existsSync(filePath)) {
            const hex = fs.readFileSync(filePath, 'utf8').trim().toLowerCase()
            if (HEX.test(hex) && hex.length === bytes * 2) return Buffer.from(hex, 'hex')
        }
    } catch (e) {
        logger.log('[ERROR] Failed to read legacy key file:', e)
    }
    return null
}

// Delete a legacy plaintext key file if present (cleanup only).
export function deleteLegacyKeyFile(filePath) {
    try {
        const fs = getBackendFs()
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            logger.log('[INFO] Deleted legacy plaintext key file')
        }
    } catch (e) {
        logger.log('[ERROR] Failed to delete legacy key file:', e)
    }
}

// Persist the autobase key through the platform adapter. Resolves true only when
// the write was durably stored (acknowledged), so callers may retire plaintext.
export async function saveAutobaseKey(key) {
    const ok = await persistBackendSecret('autobaseKey', key)
    if (ok) {
        logger.log('[INFO] Saved autobase key through secure adapter', {
            fingerprint: secretFingerprint(key.toString('hex')),
        })
    } else {
        logger.log('[ERROR] Could not durably persist autobase key through secure adapter')
    }
    return ok
}

// Load the autobase key from the adapter boot payload, falling back to the
// backend's own legacy plaintext file. Returns { key, source } so the caller can
// re-secure and clean up a key that was only found on disk.
export function loadAutobaseKey(bootSecrets, legacyFilePath) {
    const fromBoot = getBootSecretBuffer(bootSecrets, 'autobaseKey')
    if (fromBoot) {
        logger.log('[INFO] Loaded autobase key from secure adapter', {
            fingerprint: secretFingerprint(fromBoot.toString('hex')),
        })
        return { key: fromBoot, source: 'secure' }
    }
    const fromFile = readLegacyKeyFile(legacyFilePath)
    if (fromFile) {
        logger.log('[INFO] Loaded autobase key from legacy plaintext file (pending migration)')
        return { key: fromFile, source: 'legacy-file' }
    }
    return { key: null, source: null }
}

// Save encryption key through the platform adapter (acknowledged).
export async function saveEncryptionKey(key) {
    const ok = await persistBackendSecret('encryptionKey', key)
    if (ok) {
        logger.log('[INFO] Saved encryption key through secure adapter', {
            fingerprint: secretFingerprint(key.toString('hex')),
        })
    } else {
        logger.log('[ERROR] Could not durably persist encryption key through secure adapter')
    }
    return ok
}

// Load encryption key from the adapter boot payload, falling back to the legacy
// plaintext file. Returns { key, source } as loadAutobaseKey does.
export function loadEncryptionKey(bootSecrets, legacyFilePath) {
    const fromBoot = getBootSecretBuffer(bootSecrets, 'encryptionKey')
    if (fromBoot) {
        logger.log('[INFO] Loaded encryption key from secure adapter', {
            fingerprint: secretFingerprint(fromBoot.toString('hex')),
        })
        return { key: fromBoot, source: 'secure' }
    }
    const fromFile = readLegacyKeyFile(legacyFilePath)
    if (fromFile) {
        logger.log('[INFO] Loaded encryption key from legacy plaintext file (pending migration)')
        return { key: fromFile, source: 'legacy-file' }
    }
    return { key: null, source: null }
}

export async function saveOwnerAuthorityKey(secretKey) {
    const ok = await persistBackendSecret('ownerAuthorityKey', secretKey)
    if (ok) {
        logger.log('[INFO] Saved owner authority key through secure adapter', {
            fingerprint: secretFingerprint(secretKey.toString('hex')),
        })
    } else {
        logger.log('[ERROR] Could not durably persist owner authority key through secure adapter')
    }
    return ok
}

export function loadOwnerAuthorityKey(bootSecrets, legacyFilePath) {
    const fromBoot = getBootSecretBuffer(bootSecrets, 'ownerAuthorityKey')
    if (fromBoot) {
        const keyPair = createOwnerAuthorityKeyPair(fromBoot)
        if (keyPair) {
            logger.log('[INFO] Loaded owner authority key from secure adapter', {
                fingerprint: secretFingerprint(fromBoot.toString('hex')),
            })
            return { keyPair, source: 'secure' }
        }
        logger.log('[ERROR] Ignoring invalid owner authority key from secure adapter')
    }

    const fromFile = readLegacyKeyFile(legacyFilePath, 64)
    if (fromFile) {
        const keyPair = createOwnerAuthorityKeyPair(fromFile)
        if (keyPair) {
            logger.log('[INFO] Loaded owner authority key from legacy plaintext file (pending migration)')
            return { keyPair, source: 'legacy-file' }
        }
    }

    return { keyPair: null, source: null }
}

export function deleteOwnerAuthorityKey() {
    return deleteBackendSecret('ownerAuthorityKey')
}

export async function saveEpochKey(key) {
    const ok = await persistBackendSecret('epochKey', key)
    if (ok) {
        logger.log('[INFO] Saved epoch key through secure adapter', {
            fingerprint: secretFingerprint(key.toString('hex')),
        })
    } else {
        logger.log('[ERROR] Could not durably persist epoch key through secure adapter')
    }
    return ok
}

export function loadEpochKey(bootSecrets) {
    const fromBoot = getBootSecretBuffer(bootSecrets, 'epochKey')
    if (fromBoot) {
        logger.log('[INFO] Loaded epoch key from secure adapter', {
            fingerprint: secretFingerprint(fromBoot.toString('hex')),
        })
        return { key: fromBoot, source: 'secure' }
    }
    return { key: null, source: null }
}

export function deleteEpochKey() {
    return deleteBackendSecret('epochKey')
}

export async function saveEpochEncryptionKey(secretKey) {
    const ok = await persistBackendSecret('epochEncryptionKey', secretKey)
    if (ok) {
        logger.log('[INFO] Saved epoch encryption key through secure adapter', {
            fingerprint: secretFingerprint(secretKey.toString('hex')),
        })
    } else {
        logger.log('[ERROR] Could not durably persist epoch encryption key through secure adapter')
    }
    return ok
}

export function loadEpochEncryptionKey(bootSecrets) {
    const fromBoot = getBootSecretBuffer(bootSecrets, 'epochEncryptionKey')
    if (fromBoot) {
        const keyPair = createEpochEncryptionKeyPair(fromBoot)
        if (keyPair) {
            logger.log('[INFO] Loaded epoch encryption key from secure adapter', {
                fingerprint: secretFingerprint(fromBoot.toString('hex')),
            })
            return { keyPair, source: 'secure' }
        }
        logger.log('[ERROR] Ignoring invalid epoch encryption key from secure adapter')
    }
    return { keyPair: null, source: null }
}

export function deleteEpochEncryptionKey() {
    return deleteBackendSecret('epochEncryptionKey')
}

// Remove stale invite files from the old plaintext invite-persistence path.
export function deleteLegacyInviteFile(filePath) {
    try {
        const fs = getBackendFs()
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            logger.log('[INFO] Deleted legacy invite file')
        }
    } catch (e) {
        logger.log('[ERROR] Failed to delete legacy invite file:', e)
    }
}
