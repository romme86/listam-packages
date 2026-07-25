// The one decoder for a SYNC_LIST payload, shared by desktop, mobile and
// headless.
//
// SYNC_LIST has three wire shapes, accumulated over rolling upgrades:
//
//   1. `Item[]`                              — the original personal/default list
//   2. `{ list, baseKey }`                   — a shared single-list base
//   3. `{ list, listId, listType, baseKey? }` — an exact bucket envelope, so a
//      receiver can replace that bucket authoritatively (including with [])
//
// Shape 3 is what @listam/backend's buildSyncListPayload emits for any
// non-default bucket. A receiver that only understands shape 1 does not merely
// miss the identity — `Array.isArray(payload) ? payload : []` silently replaces
// the whole list with nothing, which is how listam-headless came to report an
// empty list for every non-default bucket.
//
// Unknown/older object shapes degrade to `legacy` rather than null: dropping a
// snapshot loses data, whereas treating it as an untagged list is what the old
// receivers already did. Only genuinely unusable payloads return null.

/**
 * @typedef {{ mode: 'legacy', items: any[], baseKey: string|null }} LegacySyncListSnapshot
 * @typedef {{ mode: 'bucket', listId: string, listType: string, items: any[], baseKey: string|null }} BucketSyncListSnapshot
 * @typedef {LegacySyncListSnapshot | BucketSyncListSnapshot} SyncListSnapshot
 */

function nonEmptyString (value) {
    return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @param {unknown} value the decoded JSON of a SYNC_LIST frame
 * @returns {SyncListSnapshot|null}
 */
export function decodeSyncListSnapshot (value) {
    if (Array.isArray(value)) return { mode: 'legacy', items: value, baseKey: null }

    if (!value || typeof value !== 'object') return null
    const envelope = /** @type {Record<string, unknown>} */ (value)
    if (!Array.isArray(envelope.list)) return null

    const baseKey = nonEmptyString(envelope.baseKey)

    // Shape 2 carries no bucket identity of its own. Infer it from the payload
    // so an older peer's shared-base snapshot still routes to the right bucket;
    // fall back to legacy when the list is empty and nothing can be inferred.
    const first = envelope.list.find((item) => item && typeof item === 'object')
    const listId = nonEmptyString(envelope.listId) ?? nonEmptyString(first?.listId)
    const listType = nonEmptyString(envelope.listType) ?? nonEmptyString(first?.listType)
    if (!listId || !listType) return { mode: 'legacy', items: envelope.list, baseKey }

    return { mode: 'bucket', listId, listType, items: envelope.list, baseKey }
}
