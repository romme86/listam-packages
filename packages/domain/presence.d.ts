export const PRESENCE_LIST_ID: '__presence__'
export const PRESENCE_LIST_TYPE: 'presence'
export const PRESENCE_HEARTBEAT_MS: number
export const PRESENCE_ONLINE_THRESHOLD_MS: number

export interface PresenceEntry {
    writerKey: string
    lastActiveAt: number
    lastInteractionAt: number
    sessionStartedAt: number
    cumulativeOnlineMs: number
    sessionCount: number
    updatedAt: number
    attestedBy: string | null
}

export function isPresenceItem (item: unknown): boolean

export function buildPresenceItem (args: {
    writerKey: string
    lastActiveAt?: number
    lastInteractionAt?: number
    sessionStartedAt?: number
    cumulativeOnlineMs?: number
    sessionCount?: number
    updatedAt?: number
    attestedBy?: string | null
}): Record<string, unknown>

export function reducePresence (items: unknown[] | null | undefined): Map<string, PresenceEntry>
export function isOnlineNow (entry: PresenceEntry | null | undefined, now: number, threshold?: number): boolean
export function averageOnlineMs (entry: PresenceEntry | null | undefined): number
