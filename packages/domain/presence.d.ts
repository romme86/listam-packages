export const PRESENCE_LIST_ID: '__presence__'
export const PRESENCE_LIST_TYPE: 'presence'
export const PRESENCE_HEARTBEAT_MS: number
export const PRESENCE_ONLINE_THRESHOLD_MS: number
export const COMPACTION_CAPABILITY: number

export interface PresenceEntry {
    writerKey: string
    lastActiveAt: number
    lastInteractionAt: number
    sessionStartedAt: number
    cumulativeOnlineMs: number
    sessionCount: number
    updatedAt: number
    attestedBy: string | null
    compaction: number
}

export interface CompactionReadiness {
    ready: boolean
    total: number
    readyCount: number
    blockers: Array<{ writerKey: string, reason: 'no-presence' | 'attested' | 'outdated' }>
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
    compaction?: number
}): Record<string, unknown>

export function buildAttestedPresenceItem (args: {
    writerKey: string
    observedAt?: number
    attestedBy: string
    existing?: PresenceEntry | null
}): Record<string, unknown>

export function reducePresence (items: unknown[] | null | undefined): Map<string, PresenceEntry>
export function isOnlineNow (entry: PresenceEntry | null | undefined, now: number, threshold?: number): boolean
export function averageOnlineMs (entry: PresenceEntry | null | undefined): number
export function compactionReadiness (
    presenceByWriter: Map<string, PresenceEntry> | null | undefined,
    writerKeys: Iterable<string> | null | undefined,
    required?: number,
): CompactionReadiness
