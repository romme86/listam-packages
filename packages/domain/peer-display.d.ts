/** First two alphanumerics of a value, uppercased. */
export declare function ticketInitials(value: unknown): string

/** Initials from a human name: first letters of the first two words, else the first two alphanumerics. */
export declare function nameInitials(name: unknown): string

/** Short, copy-friendly fingerprint for a 64-char writer key: first8…last4. */
export declare function shortKey(key: unknown): string

/** Coarse "time since" with no words: '45s', '12m', '3h', '2d'. */
export declare function formatAgo(ms: number): string

/** Accumulated online time with no words: '2d 4h', '3h 5m', '12m'. */
export declare function formatUptime(ms: number): string

/** The running device is online by definition; remote devices use heartbeat freshness. */
export declare function isDeviceOnline(input?: {
    isSelf?: boolean
    presence?: { lastActiveAt?: number } | null
    now?: number
}): boolean

export interface PeerDisplayInput {
    key?: string
    name?: string
    isSelf?: boolean
    isOwner?: boolean
    /** Already-translated "this device" label; each app owns its own catalog. */
    selfLabel?: string
}

export interface PeerDisplay {
    key: string
    name: string
    display: string
    initials: string
    isSelf: boolean
    isOwner: boolean
    short: string
    title: string
}

/** Resolve a writer key to everything a UI needs to show a person instead of hex. */
export declare function resolvePeerDisplay(input?: PeerDisplayInput): PeerDisplay

export type PresenceVerdict =
    | { kind: 'online' }
    | { kind: 'lastSeen'; ago: string }
    | { kind: 'unknown' }

/** Live-status verdict as a kind plus its parameter; the caller supplies the wording. */
export declare function presenceStatusVerdict(
    presence: { online?: boolean; lastActiveAt?: number } | null | undefined,
    now: number,
): PresenceVerdict
