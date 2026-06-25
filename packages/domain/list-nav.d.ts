export const UNGROUPED_GROUP_ID: '__ungrouped__'

export interface NavGroup { id: string; name: string; listIds: string[] }
export interface NavList { id: string; name: string; type: string; groupId: string | null; order: number; view?: Partial<import('./list-registry').RegistryListView>; baseKey?: string | null }
export interface NavLibrary { groups: NavGroup[]; listsById: Record<string, NavList>; defaultListId: string | null }
export interface NavMove { listId: string | null; crossedGroup: boolean; toGroupName?: string; wrapped: boolean }
export interface NavPosition { groupId: string; groupName: string; indexInGroup: number; groupSize: number; groupIndex: number; groupCount: number }

export interface ReducedRegistry { groups: Array<{ id: string; name: string; order: number }>; lists: Array<{ id: string; name: string; type: string; groupId: string | null; order: number; view?: Partial<import('./list-registry').RegistryListView>; baseKey?: string | null }> }
export interface ToNavOptions { extraLists?: Array<{ id: string; name?: string; type?: string; order?: number }>; defaultListId?: string | null; ungroupedName?: string }

export function toNavLibrary (registry: ReducedRegistry, opts?: ToNavOptions): NavLibrary
export function flatten (lib: NavLibrary): Array<{ listId: string; groupId: string; groupName: string }>
export function locate (lib: NavLibrary, listId: string): NavPosition | null
export function step (lib: NavLibrary, currentListId: string, dir: 1 | -1, opts?: { jumpGroup?: boolean; wrap?: boolean }): NavMove
export function nextList (lib: NavLibrary, id: string, opts?: { jumpGroup?: boolean; wrap?: boolean }): NavMove
export function prevList (lib: NavLibrary, id: string, opts?: { jumpGroup?: boolean; wrap?: boolean }): NavMove
export function crossesGroupBoundary (lib: NavLibrary, currentListId: string, dir: 1 | -1, opts?: { jumpGroup?: boolean }): { crosses: boolean; toGroupName?: string }
export function resolveLaunchList (lib: NavLibrary, validIds?: Set<string> | null): string | null
