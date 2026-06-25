// Two SYNCED, personal-base-only channels that make your SHARED single-list
// bases follow you across YOUR OWN devices without a manual invite. Both ride
// the normal personal item pipeline, so they are epoch-ENCRYPTED at rest and
// replicate only to members of your personal base; the backend NEVER pushes
// these items to the UI.
//
//  1. __sharedcreds__ — the READ credentials (a shared base's encryption key +
//     current epoch key). A device that has them can OPEN and DECRYPT the shared
//     base (read-only). Written by the device that SHARED the list (it has them).
//
//  2. __sharedjoinreq__ — a WRITE-access request. Autobase will not let a device
//     append until an existing writer has added it, so a sibling cannot make
//     itself a writer. Instead it auto-opens the base read-only, derives its
//     writer key, and records a request here; the OWNER device (already a writer
//     + holder of the base's owner authority) authorizes it on its next reconcile
//     by appending an owner-signed add-writer record to the shared base. The
//     sibling then replicates that record and becomes writable.
//
// TRUST BOUNDARY: anyone who is a member of your personal base can read these
// channels, so they can read (and, once authorized, co-edit) your shared lists.
// In the common single-user case the personal base's members are just your own
// devices, which is exactly the intent.

export const SHARED_CREDS_LIST_ID = '__sharedcreds__'
export const SHARED_CREDS_LIST_TYPE = 'sharedcreds'
export const SHARED_JOINREQ_LIST_ID = '__sharedjoinreq__'
export const SHARED_JOINREQ_LIST_TYPE = 'sharedjoinreq'

export function isSharedCredItem (item) {
    return !!item && typeof item === 'object' && item.listType === SHARED_CREDS_LIST_TYPE
}
export function isSharedJoinReqItem (item) {
    return !!item && typeof item === 'object' && item.listType === SHARED_JOINREQ_LIST_TYPE
}
// Items the backend must keep in the synced log (it drives auto-join from them)
// but must NEVER project to the frontend.
export function isInternalChannelItem (item) {
    return isSharedCredItem(item) || isSharedJoinReqItem(item)
}

const HEX = /^[0-9a-f]+$/i
const hexOrNull = (v) => (typeof v === 'string' && HEX.test(v) && v.length % 2 === 0 ? v.toLowerCase() : null)

// The READ-credentials item for shared base <baseKey>. Keyed by the base key, so
// re-sharing/rotation LWW-replaces it. All key material is hex.
export function buildSharedCredItem ({ baseKey, encKey, epochKey, updatedAt }) {
    return {
        id: String(baseKey),
        listId: SHARED_CREDS_LIST_ID,
        listType: SHARED_CREDS_LIST_TYPE,
        text: '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
        credBaseKey: String(baseKey),
        credEncKey: hexOrNull(encKey),
        credEpochKey: hexOrNull(epochKey),
    }
}

// Reduce cred items to Map<baseKeyHex, { baseKey, encKey, epochKey }> (LWW).
export function reduceSharedCreds (items) {
    const out = new Map()
    const at = new Map()
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isSharedCredItem(item)) continue
        const id = typeof item.id === 'string' ? item.id : null
        if (!id) continue
        const t = typeof item.updatedAt === 'number' ? item.updatedAt : 0
        if (at.has(id) && at.get(id) >= t) continue
        at.set(id, t)
        out.set(id, { baseKey: id, encKey: hexOrNull(item.credEncKey), epochKey: hexOrNull(item.credEpochKey) })
    }
    return out
}

// A WRITE-access request: device <writerKey> wants to write shared base
// <baseKey>. Keyed by (baseKey, writerKey) so each device's request is distinct.
export function buildSharedJoinReqItem ({ baseKey, writerKey, epochPublicKey, updatedAt }) {
    return {
        id: `${baseKey}:${writerKey}`,
        listId: SHARED_JOINREQ_LIST_ID,
        listType: SHARED_JOINREQ_LIST_TYPE,
        text: '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
        reqBaseKey: hexOrNull(baseKey),
        reqWriterKey: hexOrNull(writerKey),
        reqEpochPublicKey: hexOrNull(epochPublicKey),
    }
}

// Reduce request items to an array of { baseKey, writerKey, epochPublicKey }.
export function reduceSharedJoinReqs (items) {
    const out = []
    const seen = new Set()
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isSharedJoinReqItem(item)) continue
        const baseKey = hexOrNull(item.reqBaseKey)
        const writerKey = hexOrNull(item.reqWriterKey)
        if (!baseKey || !writerKey) continue
        const key = `${baseKey}:${writerKey}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ baseKey, writerKey, epochPublicKey: hexOrNull(item.reqEpochPublicKey) })
    }
    return out
}
