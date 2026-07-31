import {
    PLAN_KIND_ITEM,
    PLAN_KIND_LIST,
    buildPlanItem,
    isPlanItem,
    planItemKey,
    planListKey,
} from '@listam/domain/plan'
import { normalizeListType } from '@listam/domain/identity'

// A literal-default grocery cannot keep the reserved `default` id when it is
// promoted: every recipient already owns that id. The shared base key is
// globally unique and public, so deriving the canonical list id from it avoids
// both recipient collisions and another random-id persistence seam.
export function promotedDefaultListId (baseKeyHex) {
    const key = typeof baseKeyHex === 'string' ? baseKeyHex.trim().toLowerCase() : ''
    return key ? `list-${key}` : null
}

// Select exactly one logical surface from the old multiplexed `default`
// bucket, then rewrite only its routing identity for the new shared base.
// Item ids and every user field stay unchanged.
export function shapeDefaultPromotionItems (items, { sourceListId, sourceListType, targetListId }) {
    const source = (Array.isArray(items) ? items : []).filter((item) => (
        item &&
        item.listId === sourceListId &&
        normalizeListType(item.listType) === sourceListType &&
        !isPlanItem(item)
    ))
    return {
        source,
        seeded: source.map((item) => ({ ...item, listId: targetListId, listType: sourceListType })),
    }
}

function planArgs (item) {
    return {
        kind: item.planKind === PLAN_KIND_LIST ? PLAN_KIND_LIST : PLAN_KIND_ITEM,
        refItemId: typeof item.planRefItemId === 'string' ? item.planRefItemId : '',
        refType: typeof item.planRefType === 'string' ? item.planRefType : '',
        plannedFor: typeof item.plannedFor === 'string' ? item.plannedFor : '',
        planOrder: typeof item.planOrder === 'number' ? item.planOrder : 0,
    }
}

// Day-plan ids and pointers both contain listId. Re-IDing a promoted grocery
// without migrating them would leave the owner's Overview pointing at the now
// hidden/tombstoned default surface. New refs are written before clears by the
// caller, so a partial failure can duplicate a card but never silently lose it.
export function buildDefaultPlanMigrations (items, {
    sourceListId,
    sourceListType,
    sourceItemIds,
    targetListId,
    updatedAt,
}) {
    const ids = sourceItemIds instanceof Set ? sourceItemIds : new Set(sourceItemIds || [])
    const migrations = []
    let stamp = typeof updatedAt === 'number' ? updatedAt : 0

    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isPlanItem(item) || !item.plannedFor || item.planRefListId !== sourceListId) continue
        const args = planArgs(item)
        const isListRef = args.kind === PLAN_KIND_LIST
        if (isListRef) {
            if (args.refType !== sourceListType) continue
        } else if (!ids.has(args.refItemId)) {
            continue
        }

        const newId = isListRef
            ? planListKey(targetListId, sourceListType)
            : planItemKey(targetListId, args.refItemId)
        const nextAt = Math.max(++stamp, (typeof item.updatedAt === 'number' ? item.updatedAt : 0) + 1)
        stamp = nextAt
        const add = buildPlanItem({
            id: newId,
            ...args,
            refListId: targetListId,
            refType: isListRef ? sourceListType : args.refType,
            updatedAt: nextAt,
        })
        const clear = buildPlanItem({
            id: item.id,
            ...args,
            refListId: sourceListId,
            plannedFor: '',
            updatedAt: nextAt,
        })
        migrations.push({ add, clear })
    }
    return migrations
}
