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
//
// A `rolling` write uses a STABLE, reason‑only filename (`${reason}.listam`)
// that is overwritten in place on every backup — used by the scheduled tiers
// (scheduled-15m / scheduled-1d / scheduled-1w), so each cadence keeps exactly
// one ever‑fresh file. Rolling files are deliberately exempt from the count
// prune below, so a frequent 15‑min cadence can never evict the timestamped
// pre‑join safety backups (and vice versa).
export function writeAutoBackup(snapshot, { reason = 'manual', createdAt = Date.now(), rolling = false } = {}) {
    const password = readStoredPassword()
    if (!password) return { ok: false, reason: 'no-password' }
    const fs = getBackendFs()
    ensureDir(fs)
    const file = rolling ? `${reason}.listam` : `${reason}-${createdAt}.listam`
    fs.writeFileSync(`${dir()}/${file}`, encryptBackup(snapshot, combined(password), 'data', { createdAt }))
    if (!rolling) pruneOld(fs)
    return { ok: true, file }
}

// Snapshot the CURRENT lists into an encrypted backup. No‑throw: any failure is
// logged so it can never abort a join (or a scheduled tick). Skips silently
// when no password is set.
export async function createAutoBackup({ reason = 'manual', createdAt = Date.now(), rolling = false } = {}) {
    try {
        if (!isBackupPasswordSet()) {
            logger.log('[INFO] auto-backup skipped: no backup password set')
            return { ok: false, reason: 'no-password' }
        }
        const items = await rebuildAllItems()
        const snapshot = buildDataSnapshot({ items, boardConfig: boardConfigState?.config || null })
        const result = writeAutoBackup(snapshot, { reason, createdAt, rolling })
        if (result.ok) logger.log('[INFO] auto-backup written', { file: result.file, items: items.length })
        return result
    } catch (e) {
        logger.log('[ERROR] auto-backup failed:', e?.message ?? e)
        return { ok: false, reason: 'error' }
    }
}

// `createdAt` is a plaintext top‑level field of the AEAD envelope, so it can be
// read without the password (only the payload is encrypted). Used for rolling
// scheduled files whose fixed name carries no timestamp.
function readEnvelopeCreatedAt(fs, full) {
    try {
        const env = JSON.parse(fs.readFileSync(full, 'utf8'))
        return Number(env?.createdAt) || 0
    } catch {
        return 0
    }
}

const TIMESTAMPED = /-(\d+)\.listam$/

export function listAutoBackups() {
    try {
        const fs = getBackendFs()
        if (!fs.existsSync(dir())) return []
        return fs.readdirSync(dir())
            .filter((f) => f.endsWith('.listam'))
            .map((file) => {
                const m = TIMESTAMPED.exec(file)
                const createdAt = m ? Number(m[1]) : readEnvelopeCreatedAt(fs, `${dir()}/${file}`)
                return { file, createdAt }
            })
            .sort((a, b) => b.createdAt - a.createdAt)
    } catch (e) {
        logger.log('[ERROR] auto-backup list failed:', e?.message ?? e)
        return []
    }
}

// Only the timestamped append‑and‑prune backups (pre‑join, manual) are subject
// to the count cap. Rolling scheduled files are a fixed, self‑limiting set and
// are never pruned here.
function pruneOld(fs) {
    const timestamped = listAutoBackups().filter(({ file }) => TIMESTAMPED.test(file))
    for (const { file } of timestamped.slice(MAX_BACKUPS)) {
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

// ── Scheduled rolling backups ───────────────────────────────────────────────
//
// Three cadences, each a single fixed‑name file overwritten on every run, so the
// user always has the latest snapshot from the last 15 minutes, the last day,
// and the last week. The same unattended two‑factor secret (device key + stored
// password) encrypts them, so no prompt is ever needed once a password is set.
//
// The timers run inside the long‑lived backend on every host (desktop Pear
// worker, mobile Bare worklet, headless Node). Because phones and desktops are
// not always running, a setInterval alone would never reach the daily/weekly
// boundary — so on start we also take a CATCH‑UP backup for any tier whose
// rolling file is missing or already older than its interval. That makes the
// schedule self‑correcting across restarts and app suspensions.

export const SCHEDULE_TIERS = Object.freeze([
    { reason: 'scheduled-15m', label: '15 minutes', intervalMs: 15 * 60_000 },
    { reason: 'scheduled-1d', label: '1 day', intervalMs: 24 * 60 * 60_000 },
    { reason: 'scheduled-1w', label: '1 week', intervalMs: 7 * 24 * 60 * 60_000 },
])

const SCHEDULE_REASONS = new Set(SCHEDULE_TIERS.map((t) => t.reason))

function schedulePath() { return `${dir()}/schedule.json` }

// Scheduled backups are ON by default (the absence of a config file means "not
// yet configured" → enabled). A leaked schedule.json carries no secret — only
// the enabled flag — so it is stored as plaintext JSON.
export function isScheduleEnabled() {
    try {
        const fs = getBackendFs()
        if (!fs.existsSync(schedulePath())) return true
        const cfg = JSON.parse(fs.readFileSync(schedulePath(), 'utf8'))
        return cfg?.enabled !== false
    } catch {
        return true
    }
}

export function setScheduleEnabled(enabled) {
    const fs = getBackendFs()
    ensureDir(fs)
    const next = enabled !== false
    fs.writeFileSync(schedulePath(), JSON.stringify({ enabled: next }))
    return { ok: true, enabled: next }
}

function rollingPath(reason) { return `${dir()}/${reason}.listam` }

// Timestamp of a tier's current rolling file (from the plaintext envelope), or
// null if it has never been written.
function lastScheduledAt(fs, reason) {
    const full = rollingPath(reason)
    if (!fs.existsSync(full)) return null
    return readEnvelopeCreatedAt(fs, full) || null
}

// A snapshot of the schedule for the UI / headless status: whether it is
// enabled, whether a password is set (without which nothing is written), and
// the last run time of each tier.
export function scheduleState() {
    let fs = null
    try { fs = getBackendFs() } catch { /* no adapter yet */ }
    return {
        enabled: isScheduleEnabled(),
        passwordSet: isBackupPasswordSet(),
        tiers: SCHEDULE_TIERS.map(({ reason, label, intervalMs }) => ({
            reason,
            label,
            intervalMs,
            lastAt: fs ? safeLastScheduledAt(fs, reason) : null,
        })),
    }
}

function safeLastScheduledAt(fs, reason) {
    try { return lastScheduledAt(fs, reason) } catch { return null }
}

let _scheduleTimers = []

function runScheduledTier(reason) {
    return createAutoBackup({ reason, rolling: true })
}

// Start (or restart) the rolling backup timers. Idempotent: clears any existing
// timers first. No‑op when disabled. Safe to call after the password is set or
// the enabled flag changes. Never throws.
export function startScheduledBackups({ now = Date.now } = {}) {
    stopScheduledBackups()
    try {
        if (!isScheduleEnabled()) {
            logger.log('[INFO] scheduled backups disabled')
            return
        }
        let fs = null
        try { fs = getBackendFs() } catch { /* no adapter yet */ }

        const dueReasons = []
        for (const { reason, intervalMs } of SCHEDULE_TIERS) {
            let lastAt = null
            try { lastAt = fs ? lastScheduledAt(fs, reason) : null } catch { lastAt = null }
            if (lastAt === null || now() - lastAt >= intervalMs) dueReasons.push(reason)

            const timer = setInterval(() => {
                runScheduledTier(reason).catch((e) =>
                    logger.log('[ERROR] scheduled backup failed:', reason, e?.message ?? e))
            }, intervalMs)
            timer?.unref?.()
            _scheduleTimers.push(timer)
        }

        // Catch‑up runs serialized in the background so three tiers never hammer
        // rebuildAllItems at once, and so startup is never blocked on them.
        if (dueReasons.length) {
            void (async () => {
                for (const reason of dueReasons) {
                    try { await runScheduledTier(reason) } catch (e) {
                        logger.log('[ERROR] scheduled backup (catch-up) failed:', reason, e?.message ?? e)
                    }
                }
            })()
        }
        logger.log('[INFO] scheduled backups started', { tiers: SCHEDULE_TIERS.map((t) => t.reason), catchUp: dueReasons })
    } catch (e) {
        logger.log('[ERROR] failed to start scheduled backups:', e?.message ?? e)
    }
}

export function stopScheduledBackups() {
    for (const t of _scheduleTimers) {
        try { clearInterval(t) } catch { /* best effort */ }
    }
    _scheduleTimers = []
}

// Whether a filename belongs to a scheduled rolling tier (for UI labelling).
export function isScheduledBackupFile(file) {
    return SCHEDULE_REASONS.has(String(file).replace(/\.listam$/, ''))
}
