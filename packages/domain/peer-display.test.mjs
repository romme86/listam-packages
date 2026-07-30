// These functions had TWO implementations before this module existed — one in
// listam-desktop/src/ui.mjs and one in listam-mobile — and neither had a test.
// The values pinned here are the ones both apps were already rendering, so this
// file is as much a parity record as a unit test: if an edit changes an output,
// it changes what a user sees on both platforms at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    ticketInitials,
    nameInitials,
    shortKey,
    formatAgo,
    formatUptime,
    isDeviceOnline,
    resolvePeerDisplay,
    presenceStatusVerdict,
} from './peer-display.mjs'

test('shortKey elides a writer key to first8…last4, and only past 14 chars', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    assert.equal(shortKey(key), 'a1b2c3d4…8f90')
    // The boundary is the point: at 14 chars or under, eliding would make the
    // string LONGER than the thing it abbreviates.
    assert.equal(shortKey('12345678901234'), '12345678901234')
    assert.equal(shortKey('123456789012345'), '12345678…2345')
    assert.equal(shortKey(''), '')
    assert.equal(shortKey(null), '')
    assert.equal(shortKey(undefined), '')
})

test('ticketInitials takes two alphanumerics, uppercased, and never returns empty', () => {
    assert.equal(ticketInitials('a1b2c3'), 'A1')
    assert.equal(ticketInitials('  hello'), 'HE')
    assert.equal(ticketInitials('---'), '?', 'a value with nothing alphanumeric still needs a glyph')
    assert.equal(ticketInitials(''), '?')
    assert.equal(ticketInitials(null), '?')
    assert.equal(ticketInitials('x'), 'X', 'one character is not padded')
})

test('nameInitials prefers word boundaries, falling back to raw alphanumerics', () => {
    assert.equal(nameInitials('cassandrina-node'), 'CN')
    assert.equal(nameInitials('Anna Maria'), 'AM')
    assert.equal(nameInitials('geekom.headless'), 'GH')
    assert.equal(nameInitials('pi_headless'), 'PH')
    assert.equal(nameInitials('Alessia'), 'AL', 'a single word falls through to ticketInitials')
    // Three words still takes the first two, not the last.
    assert.equal(nameInitials('one two three'), 'OT')
    assert.equal(nameInitials('  spaced   out  '), 'SO', 'leading/repeated separators do not shift it')
    assert.equal(nameInitials(''), '?')
})

test('formatAgo switches unit at each boundary and never goes negative', () => {
    assert.equal(formatAgo(0), '0s')
    assert.equal(formatAgo(45_000), '45s')
    assert.equal(formatAgo(59_000), '59s')
    assert.equal(formatAgo(60_000), '1m')
    assert.equal(formatAgo(59 * 60_000), '59m')
    assert.equal(formatAgo(60 * 60_000), '1h')
    assert.equal(formatAgo(23 * 3600_000), '23h')
    assert.equal(formatAgo(24 * 3600_000), '1d')
    assert.equal(formatAgo(50 * 3600_000), '2d')
    // A clock that ran backwards (peer stamp ahead of ours) must not render "-3s".
    assert.equal(formatAgo(-5000), '0s')
})

test('formatUptime floors into d/h/m and drops empty leading units', () => {
    assert.equal(formatUptime(0), '0m')
    assert.equal(formatUptime(90_000), '1m', 'seconds are floored away, not rounded up')
    assert.equal(formatUptime(59 * 60_000), '59m')
    assert.equal(formatUptime(3600_000), '1h 0m')
    assert.equal(formatUptime(3600_000 + 5 * 60_000), '1h 5m')
    assert.equal(formatUptime(86_400_000), '1d 0h')
    assert.equal(formatUptime(2 * 86_400_000 + 4 * 3600_000), '2d 4h')
    assert.equal(formatUptime(-1), '0m')
})

// formatAgo ROUNDS and formatUptime FLOORS. That asymmetry is deliberate and was
// present in both original copies: "seen 2m ago" reads better rounded, while
// claiming 1h of uptime after 59m50s would overstate it.
test('formatAgo rounds where formatUptime floors', () => {
    assert.equal(formatAgo(59.6 * 60_000), '1h')
    assert.equal(formatUptime(59.6 * 60_000), '59m')
})

test('isDeviceOnline always presents self as online and keeps heartbeat rules for peers', () => {
    const now = 1_000_000_000
    assert.equal(isDeviceOnline({ isSelf: true, presence: null, now }), true)
    assert.equal(isDeviceOnline({ isSelf: true, presence: { lastActiveAt: 1 }, now }), true)
    assert.equal(isDeviceOnline({ isSelf: false, presence: null, now }), false)
    assert.equal(isDeviceOnline({ presence: { lastActiveAt: now - 1000 }, now }), true)
    assert.equal(isDeviceOnline({ presence: { lastActiveAt: 1 }, now }), false)
})

test('resolvePeerDisplay shows a name when there is one', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const d = resolvePeerDisplay({ key, name: 'geekom-headless', selfLabel: 'This device' })
    assert.equal(d.display, 'geekom-headless')
    assert.equal(d.initials, 'GH')
    assert.equal(d.short, 'a1b2c3d4…8f90')
    assert.equal(d.title, 'geekom-headless · a1b2c3d4…8f90')
    assert.equal(d.isSelf, false)
    assert.equal(d.isOwner, false)
})

test('resolvePeerDisplay falls back to the self label, then to the fingerprint', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const self = resolvePeerDisplay({ key, isSelf: true, selfLabel: 'This device' })
    assert.equal(self.display, 'This device')
    assert.equal(self.initials, 'A1', 'no name means initials come from the key')
    assert.equal(self.title, 'This device · a1b2c3d4…8f90')

    const other = resolvePeerDisplay({ key, selfLabel: 'This device' })
    assert.equal(other.display, 'a1b2c3d4…8f90')
    // The hover must carry MORE than the display, so an unnamed stranger's title
    // is the full key — that is the only place the whole thing is readable.
    assert.equal(other.title, key)
})

test('resolvePeerDisplay is total: no key, no name, no options at all', () => {
    const empty = resolvePeerDisplay()
    assert.equal(empty.key, '')
    assert.equal(empty.display, '')
    assert.equal(empty.initials, '?')
    assert.equal(empty.isSelf, false)
    assert.equal(resolvePeerDisplay({ key: null, name: null }).display, '')
})

test('resolvePeerDisplay coerces the role flags rather than passing them through', () => {
    // Callers hand these straight off a roster lookup, which can be undefined.
    const d = resolvePeerDisplay({ key: 'abc', isOwner: 1, isSelf: undefined })
    assert.equal(d.isOwner, true)
    assert.equal(d.isSelf, false)
})

test('presenceStatusVerdict distinguishes online, last-seen and never-seen', () => {
    const now = 1_000_000_000
    assert.deepEqual(presenceStatusVerdict({ online: true, lastActiveAt: now - 5000 }, now), { kind: 'online' })
    assert.deepEqual(
        presenceStatusVerdict({ online: false, lastActiveAt: now - 2 * 86_400_000 }, now),
        { kind: 'lastSeen', ago: '2d' },
    )
    // A peer that has never beaten is NOT "seen 0s ago" — it is unknown, and the
    // UI shows nothing rather than implying a sighting.
    assert.deepEqual(presenceStatusVerdict({ online: false, lastActiveAt: 0 }, now), { kind: 'unknown' })
    assert.deepEqual(presenceStatusVerdict(null, now), { kind: 'unknown' })
    assert.deepEqual(presenceStatusVerdict(undefined, now), { kind: 'unknown' })
})

test('presenceStatusVerdict trusts the online flag over the timestamp', () => {
    // isOnlineNow (@listam/domain/presence) owns the threshold. If it says online,
    // a stale-looking lastActiveAt must not override it — otherwise the threshold
    // would effectively be defined in two places.
    const now = 1_000_000_000
    assert.deepEqual(
        presenceStatusVerdict({ online: true, lastActiveAt: now - 10 * 86_400_000 }, now),
        { kind: 'online' },
    )
})
