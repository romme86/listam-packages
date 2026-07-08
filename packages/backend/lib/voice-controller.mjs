// Voice command controller (host-side).
//
// Maps a parsed voice intent ({intent, slots} from @listam/domain/voice-intent)
// onto the backend's existing write operations. It runs inside the writable host
// (headless/desktop) — the read-only leaf never reaches here. Backend ops are
// INJECTED so this module unit-tests with mocks and stays decoupled from autobase.
//
//   const ctl = createVoiceController({ addItem, deleteItem, getAllItems,
//                                       getRegistryItems, notesListId })
//   const result = await ctl.execute(parseIntent(transcript, locale))
//
// Result shape: { ok, intent, code, detail } — `code` is an i18n-key suffix
// (voice.result.* / voice.error.*) the caller can localize for a notice.

import { NOTES_LIST_TYPE, DEFAULT_LIST_ID, DEFAULT_LIST_TYPE } from '@listam/domain/identity'
import { reduceRegistry, isRegistryItem, resolveDefaultListTarget } from '@listam/domain/list-registry'
import { isBoardType } from '@listam/domain/board'

function fold (s) {
    return String(s ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

// Resolve a spoken list name to {id, type} against the synced registry.
// Returns null (no match), 'ambiguous' (>1 match), or {id, type}.
export function resolveListByName (name, registryItems) {
    const target = fold(name)
    if (!target) return null
    const { lists } = reduceRegistry(registryItems || [])
    const exact = lists.filter((l) => fold(l.name) === target)
    if (exact.length === 1) return { id: exact[0].id, type: exact[0].type }
    if (exact.length > 1) return 'ambiguous'
    const partial = lists.filter((l) => {
        const n = fold(l.name)
        return n && (n.includes(target) || target.includes(n))
    })
    if (partial.length === 1) return { id: partial[0].id, type: partial[0].type }
    if (partial.length > 1) return 'ambiguous'
    return null
}

// Voice remove must never silently destroy board tickets or registry meta-items.
function defaultIsProtected (item) {
    return isRegistryItem(item) || isBoardType(item?.listType)
}

export function createVoiceController ({
    addItem,
    deleteItem,
    getAllItems,
    getRegistryItems,
    notesListId,
    notesListType = NOTES_LIST_TYPE,
    defaultListId = DEFAULT_LIST_ID,
    defaultListType = DEFAULT_LIST_TYPE,
    isProtectedItem = defaultIsProtected,
    logger = null,
} = {}) {
    if (typeof addItem !== 'function' || typeof deleteItem !== 'function') {
        throw new Error('createVoiceController requires addItem and deleteItem')
    }
    const log = (msg, extra) => { try { logger?.info?.(`[voice] ${msg}`, extra) } catch {} }

    async function handleAdd (slots) {
        const item = (slots?.item || '').trim()
        if (!item) return { ok: false, intent: 'add_item', code: 'unknownCommand', detail: {} }

        if (slots.list) {
            const registry = (await getRegistryItems?.()) || []
            const resolved = resolveListByName(slots.list, registry)
            if (resolved === null) return { ok: false, intent: 'add_item', code: 'listNotFound', detail: { list: slots.list } }
            if (resolved === 'ambiguous') return { ok: false, intent: 'add_item', code: 'ambiguous', detail: { list: slots.list } }
            const ok = await addItem(item, resolved.id, resolved.type)
            log(ok ? `added "${item}" to ${slots.list}` : `add "${item}" failed`)
            return { ok, intent: 'add_item', code: ok ? 'added' : 'notWritable', detail: { item, list: slots.list, listId: resolved.id } }
        }

        // No spoken list: honor the project's synced default-list preference
        // (set from the app), falling back to the built-in default when unset or
        // the chosen list was deleted. Read live each add so a change takes
        // effect with no host restart.
        const registry = (await getRegistryItems?.()) || []
        const target = resolveDefaultListTarget(registry, { id: defaultListId, type: defaultListType })
        const ok = await addItem(item, target.id, target.type)
        log(ok ? `added "${item}" to default list (${target.id})` : `add "${item}" failed`)
        return { ok, intent: 'add_item', code: ok ? 'addedDefault' : 'notWritable', detail: { item, listId: target.id } }
    }

    async function handleRemove (slots) {
        const term = fold(slots?.item)
        if (!term) return { ok: false, intent: 'remove_item', code: 'unknownCommand', detail: {} }

        const all = (await getAllItems?.()) || []
        const candidates = all.filter((it) => it && typeof it.text === 'string' && it.text.trim() && !isProtectedItem(it))

        let targets = candidates.filter((it) => fold(it.text) === term)
        if (targets.length === 0) {
            const partial = candidates.filter((it) => fold(it.text).includes(term))
            if (partial.length === 0) return { ok: false, intent: 'remove_item', code: 'nothingToRemove', detail: { item: slots.item } }
            if (partial.length > 1) return { ok: false, intent: 'remove_item', code: 'ambiguous', detail: { item: slots.item, count: partial.length } }
            targets = partial
        }

        let removed = 0
        for (const it of targets) {
            if (await deleteItem(it)) removed++
        }
        log(`removed ${removed} item(s) matching "${slots.item}"`)
        return { ok: removed > 0, intent: 'remove_item', code: removed > 0 ? 'removed' : 'notWritable', detail: { item: slots.item, count: removed } }
    }

    async function handleNote (slots) {
        const text = (slots?.text || '').trim()
        if (!text) return { ok: false, intent: 'note', code: 'emptyNote', detail: {} }
        if (!notesListId) return { ok: false, intent: 'note', code: 'notesUnavailable', detail: {} }
        const ok = await addItem(text, notesListId, notesListType)
        log(ok ? 'saved note' : 'note save failed')
        return { ok, intent: 'note', code: ok ? 'noteSaved' : 'notWritable', detail: { text } }
    }

    async function execute (intentResult) {
        const r = intentResult || { intent: 'unknown', slots: {} }
        switch (r.intent) {
            case 'add_item': return handleAdd(r.slots || {})
            case 'remove_item': return handleRemove(r.slots || {})
            case 'note': return handleNote(r.slots || {})
            default: return { ok: false, intent: 'unknown', code: 'unknownCommand', detail: { raw: r.raw } }
        }
    }

    return { execute, resolveListByName: (name) => getRegistryItems?.().then((items) => resolveListByName(name, items || [])) }
}
