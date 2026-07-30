// How a peer is PRESENTED: identity (short key, initials, display name) and
// presence phrasing (how long ago, how long online, online vs last-seen).
//
// This is presentation logic, not protocol — nothing here is read by apply(), so
// changing it can never fork a base. What it replaces is genuine duplication:
// `shortKey` existed twice (desktop src/ui.mjs and mobile
// app/components/MembersDialog.tsx), and formatAgo/formatUptime existed twice
// with byte-identical logic, mobile's copy carrying the comment "mirroring the
// desktop ones". Both apps then built the same strings on top of the same
// @listam/domain/presence reducers.
//
// DESIGN RULE, and the thing that makes one implementation serve both apps:
// nothing here returns a translated string. Verdicts come back as a KIND plus
// its parameters, and each app maps that to its own catalog. The numeric
// formatters are deliberately language-neutral ("3h", "2d 4h") — they carry no
// words, so only the label around them needs translating.

import { isOnlineNow } from './presence.mjs'

/** First two alphanumerics of a value, uppercased. `'a1b2…'` -> `'A1'`. */
export function ticketInitials (value) {
    const s = String(value || '').replace(/[^a-z0-9]/gi, '')
    return (s.slice(0, 2) || '?').toUpperCase()
}

/**
 * Initials from a human name: first letters of the first two words, else the
 * first two alphanumerics. `'cassandrina-node'` -> `'CN'`, `'Alessia'` -> `'AL'`.
 */
export function nameInitials (name) {
    const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return ticketInitials(name)
}

/** Short, copy-friendly fingerprint for a 64-char writer key: first8…last4. */
export function shortKey (key) {
    const s = String(key || '')
    return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

/** Coarse "time since" with no words: `'45s'`, `'12m'`, `'3h'`, `'2d'`. */
export function formatAgo (ms) {
    const secs = Math.max(0, Math.round(Number(ms) / 1000))
    if (secs < 60) return `${secs}s`
    const mins = Math.round(secs / 60)
    if (mins < 60) return `${mins}m`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h`
    return `${Math.round(hrs / 24)}d`
}

/** Accumulated online time with no words: `'2d 4h'`, `'3h 5m'`, `'12m'`. */
export function formatUptime (ms) {
    const secs = Math.max(0, Math.floor(Number(ms) / 1000))
    const days = Math.floor(secs / 86400)
    const hrs = Math.floor((secs % 86400) / 3600)
    const mins = Math.floor((secs % 3600) / 60)
    if (days > 0) return `${days}d ${hrs}h`
    if (hrs > 0) return `${hrs}h ${mins}m`
    return `${mins}m`
}

/**
 * Whether a roster device should be presented as online in the running app.
 *
 * The local device is known to be active because it is rendering the current
 * screen, so it must not depend on receiving its own replicated heartbeat.
 * Remote devices still use the normal presence staleness threshold.
 *
 * @param {{ isSelf?: boolean, presence?: object | null, now?: number }} input
 */
export function isDeviceOnline ({ isSelf = false, presence = null, now = Date.now() } = {}) {
    return !!isSelf || isOnlineNow(presence, now)
}

/**
 * Resolve a writer key to everything a UI needs to show a person instead of hex.
 *
 * `selfLabel` is passed in already translated because it is the ONE piece of
 * copy this needs and each app owns its own catalog. Everything else is derived.
 *
 * @param {{ key?: string, name?: string, isSelf?: boolean, isOwner?: boolean, selfLabel?: string }} input
 */
export function resolvePeerDisplay ({ key, name, isSelf = false, isOwner = false, selfLabel = '' } = {}) {
    const k = String(key || '')
    const label = String(name || '')
    const short = shortKey(k)
    // A named peer shows its name; an unnamed self falls back to the "this
    // device" label; anything else shows the fingerprint rather than raw hex.
    const display = label || (isSelf ? selfLabel : short)
    const initials = label ? nameInitials(label) : ticketInitials(k)
    // The title is the hover affordance, so it carries strictly more than the
    // display does — for an unnamed, non-self peer that means the FULL key.
    const title = label
        ? `${label} · ${short}`
        : (isSelf ? `${selfLabel} · ${short}` : k)
    return { key: k, name: label, display, initials, isSelf: !!isSelf, isOwner: !!isOwner, short, title }
}

/**
 * The live-status verdict for a peer, as a kind plus its parameter.
 *
 *  - `{ kind: 'online' }`                    — beating within the threshold
 *  - `{ kind: 'lastSeen', ago: '2d' }`       — known, but not now
 *  - `{ kind: 'unknown' }`                   — no heartbeat seen this session
 *
 * The caller decides the wording. `online` is passed in rather than recomputed
 * so the threshold stays owned by @listam/domain/presence (isOnlineNow).
 *
 * @param {{ online?: boolean, lastActiveAt?: number }} presence
 * @param {number} now
 */
export function presenceStatusVerdict (presence, now) {
    if (presence?.online) return { kind: 'online' }
    const lastActiveAt = Number(presence?.lastActiveAt) || 0
    if (lastActiveAt > 0) return { kind: 'lastSeen', ago: formatAgo(Number(now) - lastActiveAt) }
    return { kind: 'unknown' }
}
