// Durable, owner-only writes for the key material a shared base keeps next to
// its Corestore (epoch key, epoch-encryption keypair, owner authority, and the
// base's own encryption key).
//
// Two problems with a plain writeFileSync:
//
//  1. Mode. `writeFileSync(path, hex)` creates 0666 & ~umask — 0644 under the
//     usual 022. On a single-user laptop that is academic, but headless targets
//     a Pi/NAS where other accounts exist, and the personal-base secret store
//     (@listam/secrets) already writes 0600. The inconsistency was the bug.
//  2. Atomicity. Truncating the only copy of a key and then crashing loses the
//     base permanently: without the epoch key its items cannot be decrypted.
//     Write to a temp file, fsync, then rename — rename is atomic within a
//     directory, so a reader sees either the old key or the new one.
//
// The fs here is the platform adapter (node / bare-fs / pear), not node:fs.
// They expose overlapping but not identical surfaces, so every hardening step
// is capability-detected: on an adapter without chmod or fsync the write still
// happens, just with weaker guarantees. Losing durability is bad; refusing to
// persist a key at all is worse.
import { logger } from './logger.mjs'

export const SECRET_FILE_MODE = 0o600
export const SECRET_DIR_MODE = 0o700

function tryCall (fn, label) {
    try {
        fn()
        return true
    } catch (e) {
        // ENOSYS/EPERM on an exotic filesystem, or the adapter not implementing
        // it. Worth knowing about, never worth failing the write for.
        logger.log(`[WARNING] secret-file: ${label} unavailable or failed:`, e?.message ?? e)
        return false
    }
}

// Best-effort: flush the file's own contents before the rename makes it visible.
// Without this a crash right after rename can leave a present-but-empty file,
// which is worse than either old or new content.
function fsyncFile (fs, path) {
    if (typeof fs.openSync !== 'function' || typeof fs.fsyncSync !== 'function') return
    let fd = null
    try {
        fd = fs.openSync(path, 'r')
        fs.fsyncSync(fd)
    } catch (e) {
        logger.log('[WARNING] secret-file: fsync failed:', e?.message ?? e)
    } finally {
        if (fd !== null && typeof fs.closeSync === 'function') {
            try { fs.closeSync(fd) } catch {}
        }
    }
}

/**
 * Write `contents` to `path` atomically and owner-only.
 * @returns {boolean} true when the destination now holds `contents`
 */
export function writeSecretFileAtomic (fs, path, contents) {
    // One instance owns a storage root at a time (see storage-lease.mjs), so a
    // fixed temp name cannot collide with a concurrent writer. A stale .tmp left
    // by a crash is simply overwritten by the next write.
    const tmp = `${path}.tmp`
    try {
        fs.writeFileSync(tmp, contents)
    } catch (e) {
        logger.log('[ERROR] secret-file: write failed:', path, e?.message ?? e)
        return false
    }

    // chmod BEFORE the rename so the key is never briefly world-readable at its
    // real path.
    if (typeof fs.chmodSync === 'function') tryCall(() => fs.chmodSync(tmp, SECRET_FILE_MODE), 'chmod')
    fsyncFile(fs, tmp)

    if (typeof fs.renameSync !== 'function') {
        // No atomic rename on this adapter: fall back to writing in place. Still
        // better than not persisting, and still chmod'ed below.
        logger.log('[WARNING] secret-file: no renameSync; writing in place (non-atomic)')
        try {
            fs.writeFileSync(path, contents)
            if (typeof fs.chmodSync === 'function') tryCall(() => fs.chmodSync(path, SECRET_FILE_MODE), 'chmod')
            return true
        } catch (e) {
            logger.log('[ERROR] secret-file: in-place write failed:', path, e?.message ?? e)
            return false
        }
    }

    try {
        fs.renameSync(tmp, path)
    } catch (e) {
        logger.log('[ERROR] secret-file: rename failed:', path, e?.message ?? e)
        return false
    }
    return true
}

/** Restrict a directory holding secrets to its owner. Best-effort. */
export function hardenSecretDir (fs, dir) {
    if (typeof fs.chmodSync !== 'function') return false
    return tryCall(() => fs.chmodSync(dir, SECRET_DIR_MODE), 'chmod dir')
}

/**
 * Tighten a secret file that an earlier build created world-readable.
 *
 * Migration for keys already on disk: they were written 0644 and nothing would
 * narrow them until the next write, which for a stable base may never come.
 * Done on READ because that is the one moment we know the file exists and
 * matters. Purely a permission change — the contents are never touched, so
 * there is no window in which the key could be lost.
 *
 * @returns {boolean} true when a widening was found and corrected
 */
export function tightenSecretFile (fs, path) {
    if (typeof fs.statSync !== 'function' || typeof fs.chmodSync !== 'function') return false
    try {
        const mode = fs.statSync(path).mode & 0o777
        if (mode === SECRET_FILE_MODE) return false
        // Only ever narrow. A deliberately stricter mode (0400) is left alone.
        if ((mode & ~SECRET_FILE_MODE) === 0) return false
        fs.chmodSync(path, SECRET_FILE_MODE)
        logger.log('[AUDIT] secret-file: tightened permissions on an existing key file')
        return true
    } catch (e) {
        logger.log('[WARNING] secret-file: could not tighten permissions:', e?.message ?? e)
        return false
    }
}
