// Automatic, durable pre-join backups of the current lists.
//
// Joining a shared project REPLACES the entire local base (see joinViaInvite in
// network.mjs — it re-inits Autobase on the host's key). So right before that
// switch we snapshot the current lists to an encrypted file under the storage
// root. The snapshot is the SAME data snapshot the manual export produces,
// through the SAME AEAD (backup-crypto.mjs) — but the "password" is a two‑factor
// secret:
//
//     combined = `${userPassword}::${deviceSecretHex}`
//
//   • deviceSecret — random 32‑byte on‑device entropy, generated once and stored
//     as hex under the storage root. A leaked backup FILE alone can't be opened
//     without it.
//   • userPassword — REQUIRED, set up front and stored encrypted under the device
//     secret so the unattended join‑time backup can read it. Restoring asks the
//     user for it again (the device can't restore without the password entered).
//
// File reads/writes go through the platform fs adapter (getBackendFs), using the
// SYNC node:fs/bare-fs surface (the adapter has no top‑level promise methods).
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'
import { getBackendFs } from './platform-fs.mjs'
import { storagePath } from '../backend.mjs'
import { encryptBackup, decryptBackup } from './backup-crypto.mjs'
import { buildDataSnapshot } from './backup-payload.mjs'
import { rebuildAllItems } from './item.mjs'
import { importBackup } from './backup.mjs'
import { boardConfigState } from './state.mjs'
import { logger } from './logger.mjs'

const MAX_BACKUPS = 20
const SEP = '::'
const DEVICE_HEX = /^[0-9a-f]{64}$/i

// Test seam: lets a unit test point the backup dir at a tmp folder without
// booting the whole backend (storagePath is only set inside startBackend).
let _dirOverride = null
export function __setAutoBackupDirForTests(dir) { _dirOverride = dir }

function dir() { return _dirOverride || `${storagePath}/auto-backups` }
function deviceKeyPath() { return `${dir()}/device.key` }
function passwordPath() { return `${dir()}/password.enc` }

function ensureDir(fs) {
    if (!fs.existsSync(dir())) fs.mkdirSync(dir(), { recursive: true })
}

// Random 32‑byte device secret, generated once and persisted as hex. Stable
// across reboots so older backups stay openable.
function deviceSecretHex() {
    const fs = getBackendFs()
    ensureDir(fs)
    const p = deviceKeyPath()
    if (fs.existsSync(p)) {
        const hex = fs.readFileSync(p, 'utf8').trim().toLowerCase()
        if (DEVICE_HEX.test(hex)) return hex
    }
    const hex = b4a.toString(randomBytes(32), 'hex')
    fs.writeFileSync(p, hex)
    return hex
}

function combined(password) { return `${password}${SEP}${deviceSecretHex()}` }

export function isBackupPasswordSet() {
    try { return getBackendFs().existsSync(passwordPath()) } catch { return false }
}

// The stored user password (decrypted with the device secret), or null.
function readStoredPassword() {
    const fs = getBackendFs()
    if (!fs.existsSync(passwordPath())) return null
    try {
        const { payload } = decryptBackup(fs.readFileSync(passwordPath(), 'utf8'), deviceSecretHex())
        return typeof payload?.password === 'string' ? payload.password : null
    } catch (e) {
        logger.log('[ERROR] auto-backup: cannot read stored password:', e?.message ?? e)
        return null
    }
}

// Set or change the backup password. Changing requires the current password and
// re‑encrypts existing backups so none are orphaned. Throws on a wrong current
// password ('Wrong password' → mapped to 'bad-password' by the RPC reply).
export async function setBackupPassword({ current, next } = {}) {
    if (typeof next !== 'string' || next.length < 8) throw new Error('password-too-short')
    const fs = getBackendFs()
    ensureDir(fs)
    const existing = readStoredPassword()
    if (existing !== null && current !== existing) throw new Error('Wrong password')
    if (existing !== null && next !== existing) reencryptExisting(existing, next)
    fs.writeFileSync(passwordPath(), encryptBackup({ password: next }, deviceSecretHex(), 'data'))
    return { ok: true }
}

function reencryptExisting(oldPassword, newPassword) {
    const fs = getBackendFs()
    const oldCombined = `${oldPassword}${SEP}${deviceSecretHex()}`
    const newCombined = `${newPassword}${SEP}${deviceSecretHex()}`
    for (const { file } of listAutoBackups()) {
        const full = `${dir()}/${file}`
        try {
            const { payload, createdAt } = decryptBackup(fs.readFileSync(full, 'utf8'), oldCombined)
            fs.writeFileSync(full, encryptBackup(payload, newCombined, 'data', { createdAt }))
        } catch (e) {
            logger.log('[WARNING] auto-backup: re-encrypt skipped for', file, e?.message ?? e)
        }
    }
}

// Encrypt + write a prepared data snapshot, then prune old files. Returns the
// filename. (Split out from createAutoBackup so it is unit‑testable without an
// Autobase.)
export function writeAutoBackup(snapshot, { reason = 'manual', createdAt = Date.now() } = {}) {
    const password = readStoredPassword()
    if (!password) return { ok: false, reason: 'no-password' }
    const fs = getBackendFs()
    ensureDir(fs)
    const file = `${reason}-${createdAt}.listam`
    fs.writeFileSync(`${dir()}/${file}`, encryptBackup(snapshot, combined(password), 'data', { createdAt }))
    pruneOld(fs)
    return { ok: true, file }
}

// Snapshot the CURRENT lists into an encrypted backup. No‑throw: any failure is
// logged so it can never abort a join. Skips silently when no password is set.
export async function createAutoBackup({ reason = 'manual', createdAt = Date.now() } = {}) {
    try {
        if (!isBackupPasswordSet()) {
            logger.log('[INFO] auto-backup skipped: no backup password set')
            return { ok: false, reason: 'no-password' }
        }
        const items = await rebuildAllItems()
        const snapshot = buildDataSnapshot({ items, boardConfig: boardConfigState?.config || null })
        const result = writeAutoBackup(snapshot, { reason, createdAt })
        if (result.ok) logger.log('[INFO] auto-backup written', { file: result.file, items: items.length })
        return result
    } catch (e) {
        logger.log('[ERROR] auto-backup failed:', e?.message ?? e)
        return { ok: false, reason: 'error' }
    }
}

export function listAutoBackups() {
    try {
        const fs = getBackendFs()
        if (!fs.existsSync(dir())) return []
        return fs.readdirSync(dir())
            .filter((f) => f.endsWith('.listam'))
            .map((file) => {
                const m = /-(\d+)\.listam$/.exec(file)
                return { file, createdAt: m ? Number(m[1]) : 0 }
            })
            .sort((a, b) => b.createdAt - a.createdAt)
    } catch (e) {
        logger.log('[ERROR] auto-backup list failed:', e?.message ?? e)
        return []
    }
}

function pruneOld(fs) {
    for (const { file } of listAutoBackups().slice(MAX_BACKUPS)) {
        try { fs.unlinkSync(`${dir()}/${file}`) } catch { /* best effort */ }
    }
}

// Restore a backup by filename. Requires the user password (combined with the
// device secret). Reuses the proven import path (LWW data merge). A wrong
// password throws → 'bad-password'; an unknown file throws → 'invalid-file'.
export async function restoreAutoBackup(file, password) {
    if (typeof password !== 'string' || !password) {
        throw new Error('A password is required to open the backup')
    }
    const fs = getBackendFs()
    const safe = String(file).replace(/[^A-Za-z0-9._-]/g, '')
    const full = `${dir()}/${safe}`
    if (!safe.endsWith('.listam') || !fs.existsSync(full)) throw new Error('not a valid backup')
    return importBackup(combined(password), fs.readFileSync(full, 'utf8'))
}
