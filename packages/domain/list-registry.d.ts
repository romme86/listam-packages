export const REGISTRY_LIST_ID: '__registry__'
export const REGISTRY_LIST_TYPE: 'registry'
export const REG_KIND_LIST: 'list'
export const REG_KIND_GROUP: 'group'
export const REG_KIND_SETTINGS: 'settings'
export const PROJECT_SETTINGS_ID: '__projectsettings__'

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
export interface RegistrySettings { defaultListId: string | null; defaultListType: string | null }
export interface ListTarget { id: string | null; type: string | null }

export function isRegistryItem (item: unknown): boolean
export function sanitizeView (view: unknown): Partial<RegistryListView>
export function buildListMetaItem (args: { id: string; name: string; type?: string; groupId?: string | null; order?: number; view?: Partial<RegistryListView>; updatedAt: number }): Record<string, unknown>
export function buildGroupMetaItem (args: { id: string; name: string; order?: number; updatedAt: number }): Record<string, unknown>
export function buildProjectSettingsItem (args?: { defaultListId?: string | null; defaultListType?: string | null; updatedAt?: number }): Record<string, unknown>
export function reduceRegistry (items: unknown[] | null | undefined): { groups: RegistryGroup[]; lists: RegistryList[]; settings: RegistrySettings | null }
export function resolveDefaultListTarget (items: unknown[] | null | undefined, fallback?: { id?: string | null; type?: string | null }): ListTarget
