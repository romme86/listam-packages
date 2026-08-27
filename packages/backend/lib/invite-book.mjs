// A set of simultaneously-live invites, replacing the single scalar invite.
//
// Why: `currentInvite` was one slot. Minting a code for a second friend
// overwrote the first friend's code, and the overwritten code then failed the
// id-match test on the host with no reply at all — the guest just waited out its
// deadline. Sharing with three people was therefore impossible by construction,
// in a way that looked exactly like a network failure. (2026-08-26: three people
// on 4G, "a fresh code per friend", nobody got in.)
//
// Each entry stays independently single-use. Raising INVITE_MAX_USES would have
// been the wrong fix: a code that admits N people is a code that admits the
// wrong people, and the value of single-use is that a leaked code is spent.
// What was actually needed is N codes, each good once.
//
// Deliberately in-memory only. `deleteLegacyInviteFile` exists because invites
// used to be written to disk and that was removed on purpose — an invite carries
// the epoch key in its signed additional data, so persisting the book would put
// live key material back on disk. The cost is that a backend restart invalidates
// outstanding codes; see `INVITE_LOSS_ON_RESTART` in the join docs.

import b4a from 'b4a'
import { INVITE_MAX_USES, consumeInviteUse, reserveInviteUse } from './invite-policy.mjs'

// Enough for "share with the family", small enough that a stuck UI minting in a
// loop cannot grow unbounded. Eviction sacrifices spent tombstones first and
// only then the oldest live code, so the codes a user just handed out survive a
// runaway.
export const MAX_LIVE_INVITES = 8

/**
 * @typedef {object} InviteEntry
 * @property {Uint8Array} id           blind-pairing invite id, matched against candidate.inviteId
 * @property {Uint8Array} invite       the code itself, z32-encoded for the user
 * @property {Uint8Array} publicKey    needed to `open()` a candidate — and therefore to `deny()` it
 * @property {any} additional          signed epoch payload handed to the joiner on confirm
 * @property {number} expires          absolute ms deadline
 * @property {number} usesRemaining
 * @property {number} epochAtMint
 * @property {number} mintedAt
 */

export function createInviteBook() {
    // Insertion-ordered, which is what makes "evict the oldest" and "return the
    // newest usable" both cheap and obvious.
    return { entries: new Map() }
}

function keyOf(id) {
    return b4a.toString(id, 'hex')
}

/**
 * Drop EXPIRED entries. Called before every read so the book never offers a code
 * the host would refuse a moment later. Spent codes are kept — see below.
 *
 * @returns {number} how many entries were dropped
 */
export function pruneInvites(book, now = Date.now()) {
    if (!book?.entries?.size) return 0
    let dropped = 0
    for (const [key, entry] of book.entries) {
        // Expiry only. A SPENT entry is deliberately kept until it expires: it is
        // the tombstone that lets the host answer "that code was already used"
        // instead of falling through to the unknown-invite branch, which holds no
        // public key and therefore cannot seal any reply at all. Forgetting a
        // spent code would recreate the silent 120s hang for the second person
        // handed the same code — the exact failure this book exists to end.
        if (!Number.isFinite(entry.expires) || now >= entry.expires) {
            book.entries.delete(key)
            dropped++
        }
    }
    return dropped
}

function isUsable(entry, now) {
    return entry.usesRemaining > 0
        && Number.isFinite(entry.expires)
        && now < entry.expires
}

/**
 * Add a freshly created blind-pairing invite to the book.
 *
 * @param {object} book
 * @param {object} invite   result of BlindPairing.createInvite, already carrying `expires`
 * @param {{ epochAtMint: number, now?: number }} opts
 * @returns {InviteEntry}
 */
export function addInvite(book, invite, { epochAtMint, now = Date.now() } = {}) {
    pruneInvites(book, now)

    // Evict spent tombstones before live codes, then oldest-first. A tombstone
    // only buys a better error message; an unspent code someone is holding is
    // the thing that must survive a cap collision.
    while (book.entries.size >= MAX_LIVE_INVITES) {
        let victim = null
        for (const [key, entry] of book.entries) {
            if (entry.usesRemaining <= 0) { victim = key; break }
        }
        if (!victim) {
            const oldest = book.entries.keys().next()
            if (oldest.done) break
            victim = oldest.value
        }
        book.entries.delete(victim)
    }

    const entry = {
        ...invite,
        epochAtMint,
        usesRemaining: INVITE_MAX_USES,
        mintedAt: now,
    }
    book.entries.set(keyOf(invite.id), entry)
    return entry
}

/**
 * Look up the entry a pairing candidate is presenting.
 *
 * Returns expired/spent entries too — the caller needs them to send a
 * *specific* refusal ("that code was already used") instead of the silence that
 * an unknown id forces. Check `reserveInvite` for usability.
 *
 * @returns {InviteEntry|null}
 */
export function findInvite(book, inviteId) {
    if (!book?.entries?.size || !inviteId) return null
    return book.entries.get(keyOf(inviteId)) ?? null
}

/**
 * Reserve one use. Mirrors invite-policy's contract so the reason strings stay
 * the same vocabulary the rest of the backend already logs.
 *
 * @returns {{ ok: boolean, reason: string, usesRemaining: number }}
 */
export function reserveInvite(book, entry, now = Date.now()) {
    if (!entry) return { ok: false, reason: 'missing', usesRemaining: 0 }

    const reservation = reserveInviteUse(entry, entry.usesRemaining, now)
    if (!reservation.ok) return reservation

    // Kept, not deleted, once spent — see pruneInvites.
    entry.usesRemaining = reservation.usesRemaining
    return reservation
}

/**
 * Return the newest entry that is still usable for the current epoch, or null.
 *
 * Newest rather than oldest: re-opening the share sheet should show the code the
 * user most recently generated, not resurrect an older one they have already
 * given away.
 *
 * @returns {InviteEntry|null}
 */
export function newestUsableInvite(book, currentEpoch, now = Date.now()) {
    pruneInvites(book, now)
    let newest = null
    for (const entry of book.entries.values()) {
        if (entry.epochAtMint !== currentEpoch || !isUsable(entry, now)) continue
        if (!newest || entry.mintedAt > newest.mintedAt) newest = entry
    }
    return newest
}

export function clearInvites(book) {
    book?.entries?.clear()
}

/**
 * Snapshot for the UI: how many codes are live and when the newest one dies.
 * The sharer has never been told either fact, which is why "the code stopped
 * working" reads as a bug rather than as a ten-minute expiry.
 */
export function describeInvites(book, currentEpoch, now = Date.now()) {
    pruneInvites(book, now)
    const live = []
    for (const entry of book.entries.values()) {
        if (entry.epochAtMint !== currentEpoch || !isUsable(entry, now)) continue
        live.push(entry)
    }
    return {
        live: live.length,
        max: MAX_LIVE_INVITES,
        newestExpiresAt: live.length
            ? live.reduce((a, e) => (e.mintedAt > a.mintedAt ? e : a)).expires
            : null,
    }
}

export { INVITE_MAX_USES, consumeInviteUse }
