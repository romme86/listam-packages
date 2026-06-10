export const SECRET_PAYLOAD_VERSION: 1
export const SECRET_STORE_KEY_PREFIX: 'listam.secret.v1.'
export const SECRET_METADATA_KEY: string
export const LEGACY_LOYALTY_CARDS_KEY: '@lista_loyalty_cards'
export const LOYALTY_CARD_HANDLES_KEY: '@lista_loyalty_card_handles'
export const LOYALTY_CARD_PAYLOAD_KEY_PREFIX: string
export const LOYALTY_CARD_METADATA_KEY: string
export const SECURE_SECRET_FILES: {
    readonly autobaseKey: 'lista-autobase-key.txt'
    readonly encryptionKey: 'lista-encryption-key.txt'
    readonly ownerAuthorityKey: 'lista-owner-authority-key.txt'
    readonly epochKey: 'lista-epoch-key.txt'
    readonly epochEncryptionKey: 'lista-epoch-encryption-key.txt'
}
export const LEGACY_CLEANUP_FILES: {
    readonly localWriterKey: 'lista-local-writer-key.txt'
    readonly pairingInvite: 'lista-invite.json'
}
export const LEGACY_SECRET_FILES: typeof SECURE_SECRET_FILES & typeof LEGACY_CLEANUP_FILES
export const SECRET_NAMES: readonly SecretName[]
export const BACKEND_SECRET_NAMES: readonly SecretName[]
export const HEX_SECRET_BYTES: Readonly<Record<SecretName, number>>

export type SecretName = keyof typeof SECURE_SECRET_FILES
export type SecretMode = 'secure-store' | 'plaintext-recovery' | 'memory-recovery'
export type ParsedSecretMode = SecretMode | 'none' | 'unknown' | string
export type BackendSecretPayload = {
    version: number
    mode: SecretMode
    secrets: Partial<Record<SecretName, string>>
}
export type ParsedBackendSecretPayload = {
    version: number
    mode: ParsedSecretMode
    secrets: Partial<Record<SecretName, string>>
}
export type PreparedBackendSecrets = {
    backendPayload: BackendSecretPayload
    mode: SecretMode
    secureStorageAvailable: boolean
    warnings: string[]
}
export type SecureSecretStore = {
    isAvailable: () => Promise<boolean>
    getItem: (key: string) => Promise<string | null>
    setItem: (key: string, value: string) => Promise<void>
    deleteItem?: (key: string) => Promise<void>
}
export type MetadataStore = {
    setItem: (key: string, value: string) => Promise<void>
}
export type LegacySecretFiles = {
    readFile: (filename: string) => Promise<string | null>
    deleteFile: (filename: string) => Promise<void>
}
export type MemorySecretStore = {
    get: (name: SecretName) => string | null
    set: (name: SecretName, value: string) => void
    delete: (name: SecretName) => void
    snapshot: () => Partial<Record<SecretName, string>>
}
export type SecretStorageAdapters = {
    secureStore: SecureSecretStore
    legacyFiles?: LegacySecretFiles
    metadataStore?: MetadataStore
    memoryStore?: MemorySecretStore
}
export type LoyaltyCardPayloadMode = 'secure-store' | 'legacy-recovery' | 'unavailable'
export type KeyValueStore = {
    getItem: (key: string) => Promise<string | null>
    setItem: (key: string, value: string) => Promise<void>
    removeItem?: (key: string) => Promise<void>
}
export type LoyaltyCardPayload = {
    id: string
    name: string
    type: string
    data: string
}
export type LoyaltyCardHandle = {
    id: string
    name: string
    type: string
    payloadRef: string
}
export type LoyaltyCardStorageAdapters = {
    secureStore: SecureSecretStore
    handleStore?: KeyValueStore
    legacyStore?: KeyValueStore
    metadataStore?: MetadataStore
}
export type PreparedLoyaltyCardPayloads = {
    handles: LoyaltyCardHandle[]
    mode: LoyaltyCardPayloadMode
    secureStorageAvailable: boolean
    migratedCount: number
    warnings: string[]
}
export type BackendSecretPersistRequest = {
    version?: number
    op?: 'set' | 'delete'
    name?: string
    value?: string | null
}
export type PersistSecretPayload = {
    version: number
    op: 'set'
    name: SecretName
    value: string
    fingerprint: string
}
export type DeleteSecretPayload = {
    version: number
    op: 'delete'
    name: SecretName
}

export function secretStoreKey(name: SecretName): string
export function loyaltyCardPayloadRef(id: unknown): string
export function loyaltyCardPayloadStoreKey(payloadRef: unknown): string | null
export function normalizeLoyaltyCardPayload(raw: unknown): LoyaltyCardPayload | null
export function normalizeLoyaltyCardHandle(raw: unknown): LoyaltyCardHandle | null
export function toLoyaltyCardHandle(card: unknown): LoyaltyCardHandle | null
export function parseLoyaltyCardPayloadList(raw: unknown): LoyaltyCardPayload[]
export function parseLoyaltyCardHandleList(raw: unknown): LoyaltyCardHandle[]
export function serializeLoyaltyCardHandles(handles: unknown[]): string
export function normalizeSecretValue(name: string, raw: unknown): string | null
export function parseSecretName(raw: unknown): SecretName | null
export function secretFingerprint(value: string): string
export function emptyBackendSecretPayload(): ParsedBackendSecretPayload
export function parseBackendSecretPayload(rawPayload: unknown, options?: { logger?: { log: (...args: unknown[]) => void } }): ParsedBackendSecretPayload
export function getBackendSecretValue(bootSecrets: ParsedBackendSecretPayload | null | undefined, name: SecretName): string | null
export function createPersistSecretPayload(name: SecretName, value: unknown): PersistSecretPayload | null
export function createDeleteSecretPayload(name: SecretName): DeleteSecretPayload | null
export function parseSecretAck(ack: unknown): boolean
export function prepareBackendSecrets(adapters: SecretStorageAdapters): Promise<PreparedBackendSecrets>
export function persistBackendSecretRequest(rawRequest: string | BackendSecretPersistRequest, adapters: SecretStorageAdapters): Promise<{ mode: SecretMode; warning?: string }>
export type FileSecretStoreFs = {
    readFileSync(path: string, encoding: string): string
    writeFileSync(path: string, data: string, options?: { mode?: number }): void
}
export function createFileSecretStore(options: { fs: FileSecretStoreFs; path: string }): SecureSecretStore
export function prepareLoyaltyCardPayloads(adapters: LoyaltyCardStorageAdapters): Promise<PreparedLoyaltyCardPayloads>
export function persistLoyaltyCardPayload(card: unknown, adapters: LoyaltyCardStorageAdapters): Promise<{ handle: LoyaltyCardHandle; mode: 'secure-store'; warnings: string[] }>
export function readLoyaltyCardPayload(handleOrRef: unknown, adapters: LoyaltyCardStorageAdapters): Promise<LoyaltyCardPayload | null>
export function deleteLoyaltyCardPayload(handleOrId: unknown, adapters: LoyaltyCardStorageAdapters): Promise<{ mode: LoyaltyCardPayloadMode; warnings: string[] }>
