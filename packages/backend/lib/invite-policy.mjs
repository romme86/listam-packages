export const INVITE_MAX_USES = 1
export const INVITE_TTL_MS = 10 * 60 * 1000

export function withInvitePolicy(invite, now = Date.now()) {
    if (!invite) return null
    return {
        ...invite,
        expires: now + INVITE_TTL_MS
    }
}

export function isInviteUsable(invite, usesRemaining, now = Date.now()) {
    return reserveInviteUse(invite, usesRemaining, now).ok
}

export function consumeInviteUse(usesRemaining) {
    return Math.max(0, usesRemaining - 1)
}

export function reserveInviteUse(invite, usesRemaining, now = Date.now()) {
    if (!invite) {
        return { ok: false, reason: 'missing', usesRemaining }
    }
    if (usesRemaining <= 0) {
        return { ok: false, reason: 'exhausted', usesRemaining }
    }
    if (!Number.isFinite(invite.expires)) {
        return { ok: false, reason: 'legacy', usesRemaining }
    }
    if (now >= invite.expires) {
        return { ok: false, reason: 'expired', usesRemaining }
    }
    return {
        ok: true,
        reason: 'reserved',
        usesRemaining: consumeInviteUse(usesRemaining)
    }
}

export function inviteExpiresInMs(invite, now = Date.now()) {
    if (!invite || !Number.isFinite(invite.expires)) return 0
    return Math.max(0, invite.expires - now)
}
