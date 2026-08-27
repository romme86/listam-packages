import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'

import { INVITE_TTL_MS, withInvitePolicy } from './invite-policy.mjs'
import {
    MAX_LIVE_INVITES,
    addInvite,
    clearInvites,
    createInviteBook,
    describeInvites,
    findInvite,
    newestUsableInvite,
    pruneInvites,
    reserveInvite,
} from './invite-book.mjs'

let nextId = 0
function fakeInvite(now = Date.now()) {
    // Shape mirrors BlindPairing.createInvite + withInvitePolicy.
    const id = b4a.alloc(32, ++nextId % 251)
    return withInvitePolicy({
        id,
        invite: b4a.alloc(64, nextId % 251),
        publicKey: b4a.alloc(32, (nextId + 100) % 251),
        additional: null,
    }, now)
}

test('several codes live at once, each independently single-use', () => {
    // The whole point. One scalar slot meant minting a code for the second
    // friend silently killed the first friend's code, and the dead code then
    // failed the host's id match with no reply at all.
    const book = createInviteBook()
    const a = addInvite(book, fakeInvite(), { epochAtMint: 1 })
    const b = addInvite(book, fakeInvite(), { epochAtMint: 1 })
    const c = addInvite(book, fakeInvite(), { epochAtMint: 1 })

    assert.equal(describeInvites(book, 1).live, 3)
    assert.ok(findInvite(book, a.id), 'minting b and c must not kill a')

    assert.equal(reserveInvite(book, a).ok, true)
    assert.equal(reserveInvite(book, b).ok, true)
    assert.equal(reserveInvite(book, c).ok, true)
})

test('a spent code is refused with a reason, not silently', () => {
    const book = createInviteBook()
    const entry = addInvite(book, fakeInvite(), { epochAtMint: 1 })

    assert.equal(reserveInvite(book, entry).ok, true)
    const second = reserveInvite(book, entry)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'exhausted', 'the reason is what the guest gets told')
})

test('an expired code reports expired rather than missing', () => {
    const book = createInviteBook()
    const minted = Date.now() - INVITE_TTL_MS - 1
    const entry = addInvite(book, fakeInvite(minted), { epochAtMint: 1, now: minted })

    // Reserved directly (not via a pruning read) so the host can still answer
    // "that code expired" instead of falling through to the unanswerable
    // unknown-invite branch.
    const reservation = reserveInvite(book, entry)
    assert.equal(reservation.ok, false)
    assert.equal(reservation.reason, 'expired')
})

test('pruning drops expired entries', () => {
    const book = createInviteBook()
    const stale = Date.now() - INVITE_TTL_MS - 1
    addInvite(book, fakeInvite(stale), { epochAtMint: 1, now: stale })
    assert.equal(book.entries.size, 1)

    assert.equal(pruneInvites(book), 1)
    assert.equal(book.entries.size, 0)
})

test('minting prunes, so a dead code never lingers behind a live one', () => {
    const book = createInviteBook()
    const stale = Date.now() - INVITE_TTL_MS - 1
    const dead = addInvite(book, fakeInvite(stale), { epochAtMint: 1, now: stale })
    const live = addInvite(book, fakeInvite(), { epochAtMint: 1 })

    assert.equal(findInvite(book, dead.id), null)
    assert.ok(findInvite(book, live.id))
    assert.equal(describeInvites(book, 1).live, 1)
})

test('the book is capped and evicts oldest first', () => {
    const book = createInviteBook()
    const entries = []
    for (let i = 0; i < MAX_LIVE_INVITES + 3; i++) {
        entries.push(addInvite(book, fakeInvite(), { epochAtMint: 1, now: Date.now() + i }))
    }
    assert.equal(book.entries.size, MAX_LIVE_INVITES)
    // The codes a user just handed out are the ones that must survive.
    assert.equal(findInvite(book, entries[0].id), null)
    assert.ok(findInvite(book, entries.at(-1).id))
})

test('newestUsableInvite ignores other epochs and prefers the newest', () => {
    const book = createInviteBook()
    const now = Date.now()
    addInvite(book, fakeInvite(), { epochAtMint: 1, now })
    const newer = addInvite(book, fakeInvite(), { epochAtMint: 1, now: now + 10 })
    addInvite(book, fakeInvite(), { epochAtMint: 2, now: now + 20 })

    const found = newestUsableInvite(book, 1, now + 30)
    assert.ok(b4a.equals(found.id, newer.id), 'the share sheet shows the most recent code')

    // An invite carries the epoch key in its signed additional data, so a
    // rotated epoch must never resurrect an old one.
    assert.equal(newestUsableInvite(book, 99, now + 30), null)
})

test('findInvite still returns a spent entry so it can be denied', () => {
    // An unknown id cannot be answered at all — we hold no public key to seal a
    // reply with. A KNOWN but spent id can, and that difference is the whole
    // reason findInvite does not filter.
    const book = createInviteBook()
    const entry = addInvite(book, fakeInvite(), { epochAtMint: 1 })
    assert.ok(entry.publicKey, 'the key that makes deny() possible')
    assert.ok(findInvite(book, entry.id))
    assert.equal(findInvite(book, b4a.alloc(32, 200)), null)
})

test('a spent code stays findable so the SECOND person is told why', () => {
    // The whole point of keeping tombstones. Delete a spent entry and the next
    // holder of that same code hits the unknown-invite branch, where we hold no
    // public key, cannot seal a reply, and they hang for the full deadline —
    // which is exactly the failure this work exists to remove.
    const book = createInviteBook()
    const entry = addInvite(book, fakeInvite(), { epochAtMint: 1 })

    assert.equal(reserveInvite(book, entry).ok, true)
    assert.ok(findInvite(book, entry.id), 'spent, but still answerable')
    assert.equal(reserveInvite(book, entry).reason, 'exhausted')

    // Spent codes must not be offered to the sharer as usable, though.
    assert.equal(newestUsableInvite(book, 1), null)
    assert.equal(describeInvites(book, 1).live, 0)
})

test('eviction sacrifices spent tombstones before live codes', () => {
    const book = createInviteBook()
    const spent = addInvite(book, fakeInvite(), { epochAtMint: 1 })
    reserveInvite(book, spent)
    const live = []
    for (let i = 0; i < MAX_LIVE_INVITES - 1; i++) {
        live.push(addInvite(book, fakeInvite(), { epochAtMint: 1 }))
    }
    // One more mint forces an eviction; the tombstone must be the victim.
    const newest = addInvite(book, fakeInvite(), { epochAtMint: 1 })

    assert.equal(findInvite(book, spent.id), null, 'the tombstone went first')
    for (const entry of live) assert.ok(findInvite(book, entry.id), 'live codes survive')
    assert.ok(findInvite(book, newest.id))
})

test('clearInvites retires everything', () => {
    const book = createInviteBook()
    addInvite(book, fakeInvite(), { epochAtMint: 1 })
    addInvite(book, fakeInvite(), { epochAtMint: 1 })

    clearInvites(book)
    assert.equal(book.entries.size, 0)
    assert.equal(describeInvites(book, 1).newestExpiresAt, null)
})

test('describeInvites reports the expiry the sharer was never shown', () => {
    const book = createInviteBook()
    const now = Date.now()
    const entry = addInvite(book, fakeInvite(now), { epochAtMint: 1, now })
    const summary = describeInvites(book, 1, now)

    assert.equal(summary.live, 1)
    assert.equal(summary.max, MAX_LIVE_INVITES)
    assert.equal(summary.newestExpiresAt, entry.expires)
    assert.equal(summary.newestExpiresAt - now, INVITE_TTL_MS)
})
