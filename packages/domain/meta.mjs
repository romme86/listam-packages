// One place that answers "is this a real user row, or a system record?"
//
// Listam rides several synced side-channels through the ordinary item pipeline —
// device names, the list registry, day-plan pointers, value ratings, presence
// heartbeats, shared-base credentials. They are all just items with a reserved
// `listType`, which is efficient but leaves every projection site responsible
// for skipping them. That responsibility was met unevenly: at the time this
// module was written the shared packages carried 41 ad-hoc filter sites, desktop
// 27 and mobile 21 — while listam-headless had none, so `dump`, `itemCount`,
// item lookup and `export` all reported presence heartbeats as user items. That
// is what made its restart tests fail (2 items written, 3 returned).
//
// Prefer these predicates over open-coding a listType comparison, and add new
// reserved buckets to the sets below rather than to another call site.
import {
    PEER_LABEL_LIST_TYPE,
    SURFACE_LABEL_LIST_TYPE,
    BUILTIN_GROUP_LIST_TYPE,
    VALUE_RETURN_LIST_TYPE,
} from './labels.mjs'
import { PRESENCE_LIST_TYPE } from './presence.mjs'
import { REGISTRY_LIST_TYPE } from './list-registry.mjs'
import { PLAN_LIST_TYPE } from './plan.mjs'

// Backend-only channels carrying shared-base read credentials and write-access
// requests. The backend never pushes them to a frontend, so in practice they do
// not reach a client projection — they are listed here so that "reserved" has a
// single complete definition and a future push-path change cannot leak them.
// The builders and reducers live in @listam/backend/lib/shared-creds.mjs.
export const SHARED_CREDS_LIST_TYPE = 'sharedcreds'
export const SHARED_JOINREQ_LIST_TYPE = 'sharedjoinreq'

// Reserved buckets whose contents are durable USER data: list names and groups,
// device and surface names, day-plan assignments, value/return ratings. They are
// not rows in a list, but losing them loses something the user created, so a
// backup or export MUST carry them.
export const DURABLE_META_LIST_TYPES = Object.freeze(new Set([
    REGISTRY_LIST_TYPE,
    PEER_LABEL_LIST_TYPE,
    SURFACE_LABEL_LIST_TYPE,
    BUILTIN_GROUP_LIST_TYPE,
    VALUE_RETURN_LIST_TYPE,
    PLAN_LIST_TYPE,
]))

// Reserved buckets that are regenerated from the live mesh or hold credentials.
// Restoring them from a backup is at best noise (a months-old "last seen") and
// at worst wrong, so they are excluded from exports.
export const VOLATILE_META_LIST_TYPES = Object.freeze(new Set([
    PRESENCE_LIST_TYPE,
    SHARED_CREDS_LIST_TYPE,
    SHARED_JOINREQ_LIST_TYPE,
]))

export const META_LIST_TYPES = Object.freeze(new Set([
    ...DURABLE_META_LIST_TYPES,
    ...VOLATILE_META_LIST_TYPES,
]))

function listTypeOf (item) {
    return item && typeof item === 'object' && typeof item.listType === 'string' ? item.listType : null
}

// True for any reserved-bucket record. Use this to decide what NOT to show as a
// row, count as an item, or expose through an item-addressed API.
export function isMetaItem (item) {
    const listType = listTypeOf(item)
    return listType !== null && META_LIST_TYPES.has(listType)
}

// True for a real user row. The complement of isMetaItem for well-formed items;
// a malformed item (no listType) counts as a user row, matching how the list
// reducer already treats it.
export function isUserItem (item) {
    return !isMetaItem(item)
}

// True for reserved records that must not be written into a backup/export.
export function isVolatileMetaItem (item) {
    const listType = listTypeOf(item)
    return listType !== null && VOLATILE_META_LIST_TYPES.has(listType)
}

// What an export/backup should carry: every user row plus the durable meta that
// records the user's own structure and naming.
export function isExportableItem (item) {
    return !isVolatileMetaItem(item)
}
