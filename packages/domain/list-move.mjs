// Moving a single item between lists and/or types, WITHIN one project.
//
// The reducer (list-reducer.mjs) buckets items by `listId` alone and keys them
// within a bucket by `id` alone; `listType` is just a field. So:
//   - moving to a DIFFERENT listId is a delete-from-source + add-to-destination
//     (a bare listId rewrite would leave the source copy → a duplicate),
//   - moving to the SAME listId (only the type changes, e.g. a built-in
//     Groceries item → the built-in Board, both on 'default') is a single
//     in-place update that flips `listType` and so changes which surface renders
//     the item.
//
// This module is the pure, DOM-free shaping of the DESTINATION item; the backend
// (lib/item.mjs `moveItem`) wraps the result in the right operation(s). Keeping
// it here makes the field-mapping matrix unit-testable in isolation and reusable
// by every host.

import { normalizeListId, normalizeListType } from './identity.mjs'
import { isBoardType, BOARD_WRITE_TYPE } from './board.mjs'

// Fields a host may legitimately supply when a non-board item is promoted into a
// board (collected by the ticket-create form). Mirrors TICKET_CREATE_FIELDS in
// @listam/backend lib/item.mjs — server-frozen fields (createdBy/completedBy/
// timeliness/inProgressSince/actualInProgressHours) are deliberately absent so a
// host cannot forge them on a fresh ticket.
export const MOVE_TICKET_FIELDS = ['description', 'checklist', 'estimatedHours', 'estimatedComplexity', 'priority', 'assignee', 'dueAt', 'status', 'blocks', 'blockedReason', 'valueRate', 'delayRate']

// True when the move stays inside the same listId bucket (only the type changes).
// The caller emits a single in-place update in that case instead of delete+add.
export function isSameSurfaceMove(sourceItem, targetListId) {
    return normalizeListId(sourceItem?.listId) === normalizeListId(targetListId)
}

// Shape the destination item for a move. `id` and the base fields are preserved
// so the move is idempotent under last-write-wins; `updatedAt` is bumped to now
// so the destination write (and the matching source delete) win against the
// existing copy.
//
// opts: { fields?, now?, writerKey? }
//   fields    - form-collected ticket fields, merged when the target is a board
//   now       - timestamp for updatedAt (defaults to Date.now())
//   writerKey - local writer key hex, stamped as createdBy on a fresh ticket
export function buildMovedItem(sourceItem, targetListId, targetListType, opts = {}) {
    const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {}
    const { fields = null, now = Date.now(), writerKey = null } = opts

    const listId = normalizeListId(targetListId)
    const targetIsBoard = isBoardType(targetListType)
    // Board lists travel under the legacy wire type for mesh dual-read.
    const listType = targetIsBoard ? BOARD_WRITE_TYPE : normalizeListType(targetListType)

    // Carry the whole source item forward (keep-dormant policy: board fields on a
    // demoted ticket ride along, ignored by grocery/todo, so a move back
    // restores the ticket's content), then re-stamp the routing fields.
    const dest = { ...source, listId, listType, updatedAt: now }

    // A moved item is a new arrival on its destination surface: drop any explicit
    // manual `order` so it floats to the top (see ordering.mjs `sortByOrder`),
    // exactly like a freshly added item.
    delete dest.order

    if (targetIsBoard) {
        const sourceWasBoard = isBoardType(source.listType)
        if (!sourceWasBoard) {
            // Promote: stamp the server-owned board invariants the same way
            // addItem does, and clear any stale frozen time-tracking that a
            // previously-demoted ticket may have carried dormant. Content fields
            // (description/checklist/blocks/priority/estimates) are kept, so a
            // re-promoted ticket restores its notes but starts a fresh workflow.
            dest.status = typeof fields?.status === 'string' ? fields.status : 'todo'
            dest.inProgressMs = 0
            dest.inProgressSince = null
            if (writerKey) dest.createdBy = writerKey
            else delete dest.createdBy
            delete dest.completedBy
            delete dest.timeliness
            delete dest.actualInProgressHours
        }
        // Merge whitelisted, form-collected ticket fields (used when a rigor
        // board needs description/checklist/estimate/complexity supplied).
        if (fields && typeof fields === 'object') {
            for (const key of MOVE_TICKET_FIELDS) {
                if (fields[key] !== undefined) dest[key] = fields[key]
            }
        }
        dest.isDone = dest.status === 'done'
    }

    return dest
}
