
// Add item operation (backend creates the canonical item)
import {RPC_MESSAGE} from "@listam/protocol";
import {generateId} from "./util.mjs";
import {autobase, store, rpc, currentList, epochKey, membershipState, boardConfigState} from './state.mjs'
import {SYNC_LIST, RPC_ADD_FROM_BACKEND} from "@listam/protocol";
import { logger } from "./logger.mjs"
import { createEncryptedListOperation } from './key-epochs.mjs'
import {
    DEFAULT_LIST_ID,
    DEFAULT_LIST_TYPE,
    createListOperation,
    normalizeListItem,
} from './list-reducer.mjs'
import { createViewCheckpoint } from './view-checkpoint.mjs'
import { isBoardType, applyStatusTransition, doneStatusesOf } from './board.mjs'

// --- WRITE SERIALIZATION (prevents concurrent autobase.append / flush races) ---
let _writeChain = Promise.resolve()

// autobase.append only completes once the local writer pipeline can flush the
// new node, and when it cannot (writer not "idle", e.g. after a writer-set
// reorg with every peer and the DHT unreachable) autobase retries in an
// unbounded zero-delay loop — the wedge-repro measured ~1.6M iterations/s at
// 99% CPU with the append promise never settling. While a peer is reachable
// the pipeline catches up in well under a second, so a writer that stays
// unflushable for a few seconds means the device is cut off and the mutation
// must be refused instead of started.
const FLUSHABLE_WAIT_MS = 4000
const FLUSHABLE_POLL_MS = 200

async function waitForFlushableWriter () {
    const deadline = Date.now() + FLUSHABLE_WAIT_MS
    for (;;) {
        if (!autobase || autobase.closing) return false
        try {
            const writer = autobase.localWriter
            if (writer && !writer.closed && writer.idle()) return true
        } catch {
            // localWriter.idle() is internal autobase API; if it changes shape,
            // fail open to the pre-gate behavior rather than refusing writes.
            return true
        }
        if (Date.now() >= deadline) return false
        // A stalled pipeline does not catch up on its own — each bounded
        // update() runs one linearizer advance cycle, which is what ingests
        // the local core after a writer-set reorg. With a reachable peer one
        // or two cycles settle it; without one it stays stalled and we refuse.
        try {
            await autobase.update()
        } catch (e) {
            logger.log('[WARNING] autobase.update failed while waiting for flushable writer:', e?.message ?? e)
        }
        await new Promise((resolve) => setTimeout(resolve, FLUSHABLE_POLL_MS))
    }
}

function refuseStalledMutation (operationType) {
    logger.log(`[WARNING] ${operationType} refused; local writer cannot flush (peers/DHT unreachable?)`)
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify({ type: 'sync-stalled', message: 'Cannot save changes: this device cannot reach any peer to sync with.' }))
    } catch (e) {
        logger.log('[ERROR] Failed to send sync-stalled message:', e)
    }
    return false
}

// Exported so the membership re-key flow (rekey.mjs) can serialize its
// epoch-rotation appends against list writes through the same chain — otherwise
// a concurrent addItem could land between the epoch flip and the re-encrypted
// snapshot and be tagged with a mismatched epoch.
export function enqueueWrite (fn) {
    // ensures writes run one-at-a-time even if RPC calls arrive concurrently
    _writeChain = _writeChain.then(fn, fn)
    return _writeChain
}

// Fields a client may supply when creating a board ticket. Server-controlled
// fields (createdBy/completedBy/timeliness/inProgressSince/actualInProgressHours)
// are deliberately excluded so they cannot be forged on create.
const TICKET_CREATE_FIELDS = ['description', 'checklist', 'estimatedHours', 'estimatedComplexity', 'priority', 'assignee', 'dueAt', 'status', 'blocks', 'blockedReason']

function pickTicketExtra (extra) {
    const out = {}
    for (const key of TICKET_CREATE_FIELDS) {
        if (extra[key] !== undefined) out[key] = extra[key]
    }
    return out
}

function localWriterKeyHex () {
    try {
        return autobase?.local?.key ? autobase.local.key.toString('hex') : null
    } catch {
        return null
    }
}

function findCurrentItem (item) {
    if (!Array.isArray(currentList)) return null
    const id = item?.id
    if (!id) return null
    return currentList.find((entry) => entry && entry.id === id) || null
}

export async function addItem (text, listId = DEFAULT_LIST_ID, listType = DEFAULT_LIST_TYPE, extra = null) {
    if (!autobase) {
        logger.log('[WARNING] addItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        logger.log('[WARNING] addItem called but autobase is not writable yet - waiting to be added as writer')
        // Notify frontend about not being writable
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            logger.log('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    logger.log('[INFO] Command RPC_ADD addItem')

    const now = Date.now()
    const item = {
        id: generateId(),                    // extra metadata, frontend can ignore
        text,
        isDone: false,
        listId: listId || DEFAULT_LIST_ID,
        listType: listType || DEFAULT_LIST_TYPE,
        timeOfCompletion: 0,
        updatedAt: now,
        timestamp: now,
    }

    // Board tickets carry extra fields supplied by the frontend on create.
    // Merge a whitelisted subset, then stamp server-controlled fields (author,
    // status/timer invariants) so a client cannot forge them.
    if (extra && typeof extra === 'object') {
        Object.assign(item, pickTicketExtra(extra))
    }
    if (isBoardType(item.listType)) {
        item.status = typeof item.status === 'string' ? item.status : 'todo'
        item.isDone = item.status === 'done'
        if (typeof item.inProgressMs !== 'number') item.inProgressMs = 0
        item.inProgressSince = item.status === 'in_progress' ? now : null
        const createdBy = localWriterKeyHex()
        if (createdBy) item.createdBy = createdBy
    }

    const op = createListOperation('add', item, { listId, listType })
    if (!op) return false

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            logger.log('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        if (!(await waitForFlushableWriter())) return refuseStalledMutation('ADD')
        // Get length before append to verify it increases
        // const lengthBefore = autobase.local.length

        await autobase.append(prepareListAppendOperation(op))

        // Flush to disk and verify persistence
        // const persisted = await persistAndVerify(lengthBefore + 1, 'ADD')
        // if (!persisted) {
        //     logger.log('[WARNING] Add operation may not have been persisted to disk!')
        // }

        logger.log('[INFO] Added item')
        return true
    })
}

// Update item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function updateItem (item) {
    if (!autobase) {
        logger.log('[WARNING] updateItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        logger.log('[WARNING] updateItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            logger.log('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    logger.log('[INFO] Command RPC_UPDATE updateItem')

    const now = typeof item?.updatedAt === 'number' ? item.updatedAt : Date.now()
    let nextItem = { ...item, updatedAt: now }
    if (item && isBoardType(item.listType)) {
        // Freeze time-in-progress and the on-time verdict at the source writer,
        // so every peer receives the same computed values rather than each
        // recomputing from another peer's clock.
        nextItem = applyStatusTransition(findCurrentItem(item), nextItem, now, {
            writerKey: localWriterKeyHex(),
            doneStatuses: doneStatusesOf(boardConfigState?.config),
        })
    }
    const op = createListOperation('update', nextItem)
    if (!op) return false

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            logger.log('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        if (!(await waitForFlushableWriter())) return refuseStalledMutation('UPDATE')
        const lengthBefore = autobase.local.length

        await autobase.append(prepareListAppendOperation(op))

        // const persisted = await persistAndVerify(lengthBefore + 1, 'UPDATE')
        // if (!persisted) {
        //     logger.log('[WARNING] Update operation may not have been persisted to disk!')
        // }

        logger.log('[INFO] Updated item')
        return true
    })
}

// Delete item operation: AUTONOMOUS, NO BACKEND MEMORY
export async function deleteItem (item) {
    if (!autobase) {
        logger.log('[WARNING] deleteItem called before Autobase is initialized')
        return false
    }

    if (!autobase.writable) {
        logger.log('[WARNING] deleteItem called but autobase is not writable yet')
        try {
            const req = rpc.request(RPC_MESSAGE)
            req.send(JSON.stringify({ type: 'not-writable', message: 'Waiting to be added as a writer by the host...' }))
        } catch (e) {
            logger.log('[ERROR] Failed to send not-writable message:', e)
        }
        return false
    }

    logger.log('[INFO] Command RPC_DELETE deleteItem')

    const op = createListOperation('delete', item)
    if (!op) return false

    return enqueueWrite(async () => {
        if (!autobase) return false
        if (autobase.closing) {
            logger.log('[WARNING] Mutation requested while Autobase is closing; ignoring.')
            return false
        }
        if (!(await waitForFlushableWriter())) return refuseStalledMutation('DELETE')
        const lengthBefore = autobase.local.length

        await autobase.append(prepareListAppendOperation(op))

        // const persisted = await persistAndVerify(lengthBefore + 1, 'DELETE')
        // if (!persisted) {
        //     logger.log('[WARNING] Delete operation may not have been persisted to disk!')
        // }

        logger.log('[INFO] Deleted item')
        return true
    })
}

// Simple inline schema validation matching the mobile ListEntry
export function validateItem (item) {
    return normalizeListItem(item) !== null
}

// Send current list to frontend
export function syncListToFrontend (list = currentList) {
    if (!rpc || !Array.isArray(list)) return
    try {
        const req = rpc.request(SYNC_LIST)
        req.send(JSON.stringify(list))
        logger.log('[INFO] Synced list to frontend:', list.length, 'items')
    } catch (e) {
        logger.log('[ERROR] Failed to sync list to frontend:', e)
    }
}

export function prepareListAppendOperation(op) {
    const currentEpoch = Number(membershipState?.currentEpoch) || 0
    if (!epochKey || currentEpoch <= 0) return op
    return createEncryptedListOperation(op, epochKey, currentEpoch) || op
}

// Persist and verify that an operation was written to disk
// Returns true if flush succeeded and length is correct, false otherwise
async function persistAndVerify (expectedLength, operationType) {
    if (!autobase || !autobase.local || !store) {
        logger.log(`[ERROR] persistAndVerify (${operationType}): autobase, local core, or store not available`)
        return false
    }

    try {
        // Force write to disk via Corestore - this flushes all cores to storage
        // Corestore.flush() ensures all pending writes are persisted
        if (typeof store.flush === 'function') {
            await store.flush()
        }

        const actualLength = autobase.local.length
        const keyHex = autobase.local.key.toString('hex').slice(0, 16)

        if (actualLength >= expectedLength) {
            logger.log(`[INFO] persistAndVerify (${operationType}): SUCCESS - flushed to disk, core ${keyHex}... length=${actualLength}`)
            return true
        } else {
            logger.log(`[WARNING] persistAndVerify (${operationType}): LENGTH MISMATCH - core ${keyHex}... length=${actualLength}, expected >= ${expectedLength}`)
            return false
        }
    } catch (e) {
        logger.log(`[ERROR] persistAndVerify (${operationType}): FLUSH FAILED -`, e.message)
        return false
    }
}

// One materialized-view checkpoint per active base. Both rebuild entry points
// below share it, so the view is scanned once and later passes resume from the
// last processed index instead of replaying from 0 (the join flow calls
// rebuildListFromPersistedOps on a 1-second poll for up to two minutes).
// initAutobase resets it whenever the base/view identity changes.
let _viewCheckpoint = createViewCheckpoint()

export function resetViewCheckpoint() {
    _viewCheckpoint.reset()
}

async function updateViewCheckpoint(caller) {
    if (!autobase || !autobase.view) {
        logger.log(`[WARNING] ${caller}: autobase or view not available`)
        return { items: [], allItems: [], membershipRecords: [] }
    }
    await autobase.update()
    return _viewCheckpoint.update(autobase.view, {
        onError: (index, error) => {
            logger.log(`[ERROR] ${caller}: error reading entry ${index}:`, error.message)
        },
    })
}

export async function rebuildListFromPersistedOps() {
    const { items } = await updateViewCheckpoint('rebuildListFromPersistedOps')
    return items
}

// Items that live OUTSIDE the default list: registry meta-items, board
// tickets, and any additional list. `currentList`/`syncListToFrontend` are
// single-list-scoped (they only carry the default list), so on a restart these
// would never reach the frontend and created lists/tickets would vanish. We
// surface them here so they can be re-projected per item.
export async function rebuildExtraListItems() {
    const { items, allItems = [] } = await updateViewCheckpoint('rebuildExtraListItems')
    const defaultIds = new Set(items.map((it) => it && it.id).filter(Boolean))
    return allItems.filter((it) => it && it.id && !defaultIds.has(it.id))
}

// Push each item to the frontend as an individual add. Unlike SYNC_LIST (which
// the frontend folds into the *selected* list), the per-item add path routes
// each entry to its own listId bucket, so registry meta-items and board
// tickets land where they belong. Upsert semantics make this idempotent.
export function projectItemsToFrontend(items) {
    if (!rpc || !Array.isArray(items) || items.length === 0) return
    let projected = 0
    for (const item of items) {
        if (!item) continue
        try {
            const req = rpc.request(RPC_ADD_FROM_BACKEND)
            req.send(JSON.stringify(item))
            projected++
        } catch (e) {
            logger.log('[ERROR] Failed to project item to frontend:', e)
        }
    }
    if (projected > 0) logger.log('[INFO] Re-projected extra-list items to frontend:', projected)
}

// Read the owner-signed membership records that apply() persisted into the view,
// in linearized order. Callers fold these back through reduceMembershipLog to
// restore membership state after a restart (the in-memory state is not durable).
export async function readPersistedMembershipRecords() {
    const { membershipRecords } = await updateViewCheckpoint('readPersistedMembershipRecords')
    return membershipRecords
}
