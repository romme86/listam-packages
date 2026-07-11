export const REGISTRY_LIST_ID: '__registry__'
export const REGISTRY_LIST_TYPE: 'registry'
export const REG_KIND_LIST: 'list'
export const REG_KIND_GROUP: 'group'

export interface RegistryListView {
    isGridView: boolean
    categoriesEnabled: boolean
    categoryHeadersVisible: boolean
    showFab: boolean
    gridIconSize: 'small' | 'medium' | 'normal' | 'large'
    listTextSize: 'small' | 'medium' | 'normal' | 'large'
    listAlignment: 'left' | 'center'
    listItemSpacing: 'compact' | 'cozy' | 'normal' | 'relaxed'
    itemIconVariant: 'illustrated' | 'minimal'
}

export interface RegistryGroup { id: string; name: string; order: number }
export interface RegistryList { id: string; name: string; type: string; groupId: string | null; order: number; view?: Partial<RegistryListView> }

export function isRegistryItem (item: unknown): boolean
export function sanitizeView (view: unknown): Partial<RegistryListView>
export function buildListMetaItem (args: { id: string; name: string; type?: string; groupId?: string | null; order?: number; view?: Partial<RegistryListView>; baseKey?: string | null; updatedAt: number }): Record<string, unknown>
export function buildGroupMetaItem (args: { id: string; name: string; order?: number; updatedAt: number }): Record<string, unknown>
export function reduceRegistry (items: unknown[] | null | undefined): { groups: RegistryGroup[]; lists: RegistryList[] }
export function isListNameTaken (items: unknown[] | null | undefined, name: string, opts?: { excludeId?: string | null }): boolean
