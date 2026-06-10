export const OWNER_CONTROL_VERSION: 1
export const COMMAND_TS_WINDOW_MS: number
export const PAIRING_TTL_MS: number
export const ROTATE_SCOPE: 'device:rotate'

export type Capability =
    | 'status:read'
    | 'diagnostics:read'
    | 'topics:configure'
    | 'invite:create'
    | 'export:create'
    | 'import:apply'
    | 'service:shutdown'

export type OwnerControlCommand =
    | 'status'
    | 'diagnostics'
    | 'topics'
    | 'invite'
    | 'export'
    | 'import'
    | 'shutdown'
    | 'rotate'

export const CAPABILITIES: readonly Capability[]
export const COMMAND_SCOPES: Readonly<Record<OwnerControlCommand, string>>

export type DeviceKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }
export type CommandEnvelope = {
    v: number
    commandId: string
    deviceId: string
    command: OwnerControlCommand
    scope: string
    ts: number
    seq: number
    payloadHash: string
    payload: unknown
    signature: string
}
export type RegisteredDevice = {
    deviceId: string
    name: string
    capabilities: Capability[]
    addedAt: number
    revokedAt: number | null
    rotatedTo: string | null
    lastSeq: number
}
export type AuthResult = { ok: true; device?: RegisteredDevice } | { ok: false; reason: string }
export type DeviceRegistry = {
    addDevice(input: { deviceId: string; name?: string; capabilities?: string[]; now: number }): AuthResult
    getDevice(deviceId: string): RegisteredDevice | null
    listDevices(): RegisteredDevice[]
    revokeDevice(deviceId: string, now: number): AuthResult
    rotateDevice(deviceId: string, newDeviceId: string, now: number): AuthResult
    recordSeq(deviceId: string, seq: number): void
    toJSON(): { version: number; devices: RegisteredDevice[] }
}
export type PairingOffer = {
    secretHashHex: string
    capabilities: Capability[]
    expiresAt: number
    used: boolean
}

export function createDeviceKeyPair(seed?: Uint8Array | string | null): DeviceKeyPair
export function deviceIdFromPublicKey(publicKey: Uint8Array | string): string | null
export function canonicalJson(value: unknown): string
export function payloadHashHex(payload: unknown): string
export function createCommandEnvelope(input: { keyPair: DeviceKeyPair; command: OwnerControlCommand; payload?: unknown; seq: number; now: number }): CommandEnvelope
export function verifyCommandEnvelope(envelope: unknown, options: { now: number; windowMs?: number }): AuthResult
export function createDeviceRegistry(serialized?: { devices?: unknown[] } | null): DeviceRegistry
export function authorizeCommand(registry: DeviceRegistry, envelope: unknown, options: { now: number; windowMs?: number }): AuthResult
export function createPairingOffer(input: { serverPublicKey: Uint8Array | string; capabilities?: string[]; now: number; ttlMs?: number }): { code: string; offer: PairingOffer }
export function parsePairingCode(code: string): { serverPublicKeyHex: string; secretHex: string } | null
export function createPairingRequest(input: { keyPair: DeviceKeyPair; secretHex: string; name?: string; now: number }): Record<string, unknown>
export function verifyPairingRequest(request: unknown, offer: PairingOffer, options: { now: number; windowMs?: number }): { ok: true; device: { deviceId: string; name: string; capabilities: Capability[] } } | { ok: false; reason: string }
export function createRotationPayload(newKeyPair: DeviceKeyPair): { newDeviceId: string }
export function applyRotation(registry: DeviceRegistry, envelope: CommandEnvelope, options: { now: number }): AuthResult
export function normalizeCapabilities(capabilities: unknown): Capability[]
export type OwnerControlSession = {
    deviceId: string | null
    request(command: OwnerControlCommand, payload?: unknown): Promise<any>
    pair(secretHex: string, name?: string): Promise<any>
    handleLine(line: string): boolean
    pendingCount(): number
}
export function createOwnerControlSession(input: { keyPair: DeviceKeyPair; write: (line: string) => void; now?: () => number; seqStart?: number }): OwnerControlSession
