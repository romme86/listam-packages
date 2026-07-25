import { DEFAULT_LIST_ID } from '@listam/domain/identity'

// `currentList` is the materialized DEFAULT-list projection. A snapshot for a
// non-default personal bucket therefore cannot reuse it: the frontend needs the
// snapshot operation's own items plus its bucket identity so it can replace
// that bucket exactly (including replacing it with an empty array).
//
// Keep the established personal/default wire shape byte-for-byte compatible:
//   personal/default -> item[]
// Structured snapshots extend the existing shared `{ list, baseKey }` envelope
// with bucket identity so upgraded renderers can replace it authoritatively.
export function buildSyncListPayload({ role, baseKeyHex, operation, currentList }) {
    if (role === 'shared' && baseKeyHex) {
        return {
            list: operation?.value ?? currentList,
            listId: operation?.listId,
            listType: operation?.listType,
            baseKey: baseKeyHex,
        }
    }

    if (operation?.listId === DEFAULT_LIST_ID) return currentList

    return {
        list: operation?.value,
        listId: operation?.listId,
        listType: operation?.listType,
    }
}
