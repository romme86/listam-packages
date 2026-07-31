import { REGISTRY_LIST_ID, REGISTRY_LIST_TYPE } from './list-registry.mjs'

// Durable, non-rendered metadata recording where a re-ID promotion came from.
// It deliberately uses its own registry item instead of fields on the list
// descriptor: clients rebuild descriptors on rename/move/view changes and
// would otherwise unknowingly strip recovery-only fields.
export const REG_KIND_SHARED_SOURCE = 'shared-source'

export function buildSharedSourceItem ({ baseKey, targetListId, sourceListId, sourceListType, updatedAt }) {
    const key = String(baseKey || '')
    return {
        id: `shared-source:${key}`,
        listId: REGISTRY_LIST_ID,
        listType: REGISTRY_LIST_TYPE,
        text: '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
        regKind: REG_KIND_SHARED_SOURCE,
        sourceBaseKey: key,
        sourceTargetListId: String(targetListId || ''),
        sourceListId: String(sourceListId || ''),
        sourceListType: String(sourceListType || ''),
    }
}

// Map shared base key -> source identity. Items are already LWW-reduced by the
// personal base, but keep a timestamp guard so this remains correct on raw logs.
export function reduceSharedSources (items) {
    const out = new Map()
    const at = new Map()
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!item || item.regKind !== REG_KIND_SHARED_SOURCE) continue
        const baseKey = typeof item.sourceBaseKey === 'string' ? item.sourceBaseKey : ''
        const targetListId = typeof item.sourceTargetListId === 'string' ? item.sourceTargetListId : ''
        const sourceListId = typeof item.sourceListId === 'string' ? item.sourceListId : ''
        const sourceListType = typeof item.sourceListType === 'string' ? item.sourceListType : ''
        if (!baseKey || !targetListId || !sourceListId || !sourceListType) continue
        const stamp = typeof item.updatedAt === 'number' ? item.updatedAt : 0
        if (at.has(baseKey) && at.get(baseKey) >= stamp) continue
        at.set(baseKey, stamp)
        out.set(baseKey, { baseKey, targetListId, sourceListId, sourceListType })
    }
    return out
}
