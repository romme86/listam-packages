export const PEER_LABEL_LIST_ID: '__peers__'
export const PEER_LABEL_LIST_TYPE: 'peer'
export const SURFACE_LABEL_LIST_ID: '__surfacenames__'
export const SURFACE_LABEL_LIST_TYPE: 'surfacename'
export const MAX_LABEL_NAME: 64

export function isPeerLabelItem (item: unknown): boolean
export function isSurfaceLabelItem (item: unknown): boolean
export function isLabelItem (item: unknown): boolean

export function cleanLabelName (name: unknown): string
export function surfaceLabelKey (listId: string, type: string): string

export function buildPeerLabelItem (args: { writerKey: string; name: string; updatedAt: number }): Record<string, unknown>
export function buildSurfaceLabelItem (args: { listId: string; type: string; name: string; updatedAt: number }): Record<string, unknown>

export function reducePeerLabels (items: unknown[] | null | undefined): Map<string, string>
export function reduceSurfaceLabels (items: unknown[] | null | undefined): Map<string, string>
