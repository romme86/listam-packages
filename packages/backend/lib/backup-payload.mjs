// Pure helpers that shape the backup payloads and turn an imported data
// snapshot back into list operations. No autobase / crypto / IO here — the
// orchestrator (backup.mjs) wires these to live state.
import { createListOperation } from './list-reducer.mjs'
import { isInternalChannelItem } from './shared-creds.mjs'
import { REG_KIND_LIST } from './list-registry.mjs'
import { DEFAULT_LIST_ID } from '@listam/domain/identity'

export const BACKUP_DATA_VERSION = 1
export const BACKUP_SEED_VERSION = 1

// The full instance identity, per the product decision: enough to restore or
// clone this instance and stay connected to shared lists. autobaseKey /
// encryptionKey / ownerAuthorityKey are the required core; the epoch keys only
// exist once a base has rotated (shared with other members) and are optional.
export const SEED_SECRET_NAMES = Object.freeze([
    'autobaseKey',
    'encryptionKey',
    'ownerAuthorityKey',
    'epochKey',
    'epochEncryptionKey',
])
export const SEED_REQUIRED_SECRETS = Object.freeze(['autobaseKey', 'encryptionKey', 'ownerAuthorityKey'])

function isItem(value) {
    return value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0
}

// Build the content snapshot. `items` is the full materialized item set across
// every list (registry meta-items are ordinary entries with
// listType==='registry', so they ride along untouched). The internal
// cross-device-sync channels (shared-base credentials / write requests) are
// EXCLUDED — they are transient key material, not user data, and re-propagate
// from the live personal base; keeping them out of the backup file is
// defense-in-depth for the credentials they carry.
export function buildDataSnapshot({ items = [], boardConfig = null } = {}) {
    return {
        snapshotVersion: BACKUP_DATA_VERSION,
        items: Array.isArray(items) ? items.filter((it) => isItem(it) && !isInternalChannelItem(it)) : [],
        boardConfig: boardConfig && typeof boardConfig === 'object' ? boardConfig : null,
    }
}

export function parseDataSnapshot(payload) {
    if (!payload || typeof payload !== 'object') return { items: [], boardConfig: null }
    return {
        items: Array.isArray(payload.items) ? payload.items.filter(isItem) : [],
        boardConfig: payload.boardConfig && typeof payload.boardConfig === 'object' ? payload.boardConfig : null,
    }
}

// Turn snapshot items into normalized 'add' operations that PRESERVE each
// item's id and updatedAt — so the import merges by last-write-wins and a
// re-import of the same file is a content no-op. The caller appends each op
// through the current-epoch encryption path (prepareListAppendOperation).
export function snapshotItemsToOps(items) {
    const ops = []
    for (const item of Array.isArray(items) ? items : []) {
        const op = createListOperation('add', sanitizeImportedItem(item), { listId: item?.listId, listType: item?.listType })
        if (op) ops.push(op)
    }
    return ops
}

// 'default' multiplexes the built-in surfaces and is never base-routed. A
// backup file (malicious or corrupt) that carries a registry meta-item pointing
// 'default' at a shared base would otherwise re-introduce the regBaseKey on
// import; strip it so an import can never re-create the multiplexing/misroute.
function sanitizeImportedItem(item) {
    if (item && item.regKind === REG_KIND_LIST && item.id === DEFAULT_LIST_ID && item.regBaseKey != null) {
        const { regBaseKey, ...rest } = item
        return rest
    }
    return item
}

export function buildSeedPayload(secrets) {
    const out = {}
    for (const name of SEED_SECRET_NAMES) {
        if (typeof secrets?.[name] === 'string' && secrets[name].length > 0) out[name] = secrets[name]
    }
    return { seedVersion: BACKUP_SEED_VERSION, secrets: out }
}

export function parseSeedPayload(payload) {
    const secrets = payload && typeof payload === 'object' && payload.secrets && typeof payload.secrets === 'object'
        ? payload.secrets
        : {}
    const out = {}
    for (const name of SEED_SECRET_NAMES) {
        if (typeof secrets[name] === 'string' && secrets[name].length > 0) out[name] = secrets[name]
    }
    return out
}

export function missingRequiredSeeds(secrets) {
    return SEED_REQUIRED_SECRETS.filter((name) => !(typeof secrets?.[name] === 'string' && secrets[name].length > 0))
}
