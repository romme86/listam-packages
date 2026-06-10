export type ClientEvent =
    | { type: 'add-from-backend'; item: unknown; raw: string }
    | { type: 'delete-from-backend'; item: unknown; raw: string }
    | { type: 'invalid-json'; command: number; raw: string | null; error: string }
    | { type: 'invite-key'; key: string | null }
    | { type: 'message'; payload: any; raw: string }
    | { type: 'message-empty' }
    | { type: 'persist-secret'; payload: string | null }
    | { type: 'reset' }
    | { type: 'sync-list'; items: unknown; raw: string }
    | { type: 'unknown'; command: number; data: string | null }
    | { type: 'update-from-backend'; item: unknown; raw: string }

export type ClientAdapter = {
    name: string
    encodeData(value: unknown): unknown
}

export const CLIENT_EVENT_TYPES: Readonly<Record<string, string>>
export const nodeClientAdapter: ClientAdapter
export const workletClientAdapter: ClientAdapter

export function decodeBackendRequest(
    requestOrCommand: { command: number; data?: unknown } | number,
    data?: unknown,
): ClientEvent
export function decodeWithClientAdapter(
    adapter: ClientAdapter,
    command: number,
    payload: unknown,
): ClientEvent
export function encodePayload(value: unknown): string
export function dataToString(data: unknown): string | null

export type ChannelEvent = ClientEvent & { reply(value: unknown): void }
export type BackendChannel = {
    platform: {
        createRpc(handler: (req: { command: number; data: Uint8Array; reply(value: unknown): void }, error: unknown) => unknown): {
            request(command: number): { command: number; send(data: unknown): void; reply(): Promise<unknown> }
            close(): void
        }
    }
    client: {
        send(command: number, payload?: unknown): Promise<unknown>
        onEvent(listener: (event: ChannelEvent) => void): () => void
        isConnected(): boolean
    }
}
export function createBackendChannel(): BackendChannel
