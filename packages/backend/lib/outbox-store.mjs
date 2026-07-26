// Persistence + replay driver around the pure queue in outbox.mjs.
//
// Everything the backend needs to actually keep a refused write is here: load on
// boot, persist on change, and replay when the writer can flush again. Kept
// separate from outbox.mjs so the ordering and precondition rules stay testable
// without an fs, and separate from item.mjs so the write path gains one call
// rather than a queue implementation.
//
// Dependencies are injected rather than imported: item.mjs holds live module
// bindings for autobase/epoch state, and reaching back into it from here would
// close an import cycle that the backend already suffers from elsewhere.
import { logger } from './logger.mjs'
import { writeSecretFileAtomic } from './secret-file.mjs'
import {
    createOutboxEntry,
    deserialize,
    enqueue,
    noteAttempt,
    planReplay,
    removeEntry,
    serialize,
} from './outbox.mjs'

export const OUTBOX_FILENAME = 'outbox.json'

/**
 * @param {object} deps
 * @param {any} deps.fs platform fs adapter
 * @param {string} deps.storagePath backend storage root
 * @param {() => number} [deps.now]
 * @param {(entry: any) => Promise<boolean>} deps.replayEntry performs the write;
 *   resolves true when it landed.
 * @param {() => number|null} [deps.currentEpoch]
 * @param {(entry: any) => string|null|undefined} [deps.baseKeyForList]
 * @param {(event: object) => void} [deps.notify] pushes a message to the host
 */
export function createOutboxStore ({
    fs,
    storagePath,
    now = Date.now,
    replayEntry,
    currentEpoch = () => null,
    baseKeyForList = () => undefined,
    notify = () => {},
} = {}) {
    const path = `${storagePath}/${OUTBOX_FILENAME}`
    let entries = []
    let loaded = false
    // One replay at a time. Two concurrent passes would append the same entry
    // twice — harmless for LWW updates, not for anything else.
    let replaying = false

    function load () {
        if (loaded) return entries
        loaded = true
        try {
            if (fs?.existsSync?.(path)) entries = deserialize(fs.readFileSync(path, 'utf8'))
        } catch (e) {
            // A corrupt or unreadable outbox must never stop the backend booting.
            logger.log('[WARNING] outbox: could not load, starting empty:', e?.message ?? e)
            entries = []
        }
        if (entries.length) logger.log(`[INFO] outbox: ${entries.length} queued mutation(s) restored`)
        return entries
    }

    function persist () {
        try {
            // Queued entries carry user content, so they get the same owner-only
            // atomic write as key material.
            writeSecretFileAtomic(fs, path, serialize(entries))
        } catch (e) {
            logger.log('[ERROR] outbox: persist failed:', e?.message ?? e)
        }
    }

    /** Keep a refused mutation instead of dropping it. Returns the entry. */
    function queue ({ id, command, payload, listId = null, baseKey = null }) {
        load()
        const entry = createOutboxEntry({
            id,
            command,
            payload,
            listId,
            baseKey,
            epoch: currentEpoch(),
            now: now(),
        })
        entries = enqueue(entries, entry)
        persist()
        logger.log('[INFO] outbox: queued a mutation the writer could not flush', { id, command })
        notify({ type: 'write-queued', id, listId, queued: entries.length })
        return entry
    }

    /**
     * Replay everything whose world has not moved on. Entries that cannot
     * replay stay queued and are reported, so the user can decide — silently
     * discarding a stale edit would be the same data loss in a new costume.
     */
    async function replay () {
        load()
        if (replaying || entries.length === 0) return { replayed: 0, blocked: 0 }
        replaying = true
        try {
            const { ready, blocked } = planReplay(entries, {
                epoch: currentEpoch(),
                resolveBaseKeyForList: baseKeyForList,
                now: now(),
            })

            let replayed = 0
            for (const entry of ready) {
                let ok = false
                try {
                    ok = await replayEntry(entry)
                } catch (e) {
                    logger.log('[ERROR] outbox: replay threw:', e?.message ?? e)
                    ok = false
                }
                if (ok) {
                    entries = removeEntry(entries, entry.id)
                    replayed++
                } else {
                    // Still not flushable. Keep it, but count the attempt so a
                    // permanently stuck entry is visible rather than silent.
                    entries = entries.map((e) => (e.id === entry.id ? noteAttempt(e, now()) : e))
                    break // the writer is down again; stop hammering it
                }
            }

            if (replayed > 0 || blocked.length > 0) persist()
            if (replayed > 0) {
                logger.log(`[INFO] outbox: replayed ${replayed} queued mutation(s)`)
                notify({ type: 'write-replayed', count: replayed, queued: entries.length })
            }
            if (blocked.length > 0) {
                logger.log(`[WARNING] outbox: ${blocked.length} queued mutation(s) cannot replay automatically`)
                notify({
                    type: 'write-needs-decision',
                    blocked: blocked.map((b) => ({ id: b.entry.id, listId: b.entry.listId, reason: b.reason })),
                })
            }
            return { replayed, blocked: blocked.length }
        } finally {
            replaying = false
        }
    }

    /** Drop an entry the user chose to discard. */
    function discard (id) {
        load()
        const before = entries.length
        entries = removeEntry(entries, id)
        if (entries.length !== before) persist()
        return before !== entries.length
    }

    return {
        load,
        queue,
        replay,
        discard,
        path,
        list: () => load().slice(),
        size: () => load().length,
        // Test hook: forget in-memory state so a fresh instance re-reads disk.
        _reset: () => { entries = []; loaded = false },
    }
}
