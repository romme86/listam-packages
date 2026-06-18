export const SERVICE_UUID: string
export const CHAR_CONFIG_UUID: string
export const CHAR_STATUS_UUID: string
export const ADVERTISED_NAME_PREFIX: string
export const PROVISIONING_PAYLOAD_VERSION: 1
export const MAX_WIFI_NETWORKS: 3

export const FRAME_BEGIN: 0x01
export const FRAME_CHUNK: 0x02
export const FRAME_COMMIT: 0x03
export const DEFAULT_MTU: number

export const STATUS: Readonly<{
    IDLE: 0
    RECEIVING: 1
    APPLYING: 2
    OK: 3
    ERR_CRC: 4
    ERR_DECODE: 5
    ERR_VALIDATE: 6
    ERR_NVS: 7
}>

export function statusName(code: number): string
export function isTerminalStatus(code: number): boolean
export function isErrorStatus(code: number): boolean
export function isHex32(value: unknown): boolean
export function crc16(bytes: Uint8Array | number[]): number

export interface WifiNetwork {
    ssid: string
    psk?: string
}

export interface ProvisioningPayload {
    v: 1
    control_key: string
    hub_addr: string
    wifi: WifiNetwork[]
    audio_addr?: string
    wake_db_threshold?: number
    led_gpio?: number
}

export interface BuildPayloadInput {
    controlKey: string
    hubAddr: string
    wifi?: WifiNetwork[]
    audioAddr?: string
    wakeDbThreshold?: number
    ledGpio?: number
}

export function buildProvisioningPayload(input: BuildPayloadInput): ProvisioningPayload
export function validateProvisioningPayload(payload: ProvisioningPayload): ProvisioningPayload
export function encodePayload(payload: ProvisioningPayload): Uint8Array
export function decodePayload(bytes: Uint8Array): ProvisioningPayload
export function chunkPayload(bytes: Uint8Array | number[], mtu?: number): Uint8Array[]
export function reassemble(
    frames: Uint8Array[],
): { ok: true; payload: Uint8Array } | { ok: false; error: string }

export interface ProvisioningTransport {
    write(charUuid: string, bytes: Uint8Array): Promise<void>
    subscribe(
        charUuid: string,
        onValue: (value: Uint8Array) => void,
    ): Promise<(() => void | Promise<void>) | void>
    mtu?: number
}

export function provisionLeaf(options: {
    transport: ProvisioningTransport
    payload: ProvisioningPayload
    mtu?: number
    onStatus?: (code: number, name: string) => void
    timeoutMs?: number
}): Promise<{ ok: true }>
