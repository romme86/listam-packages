import b4a from 'b4a'
import {
    RPC_ADD_FROM_BACKEND,
    RPC_DELETE_FROM_BACKEND,
    RPC_GET_KEY,
    RPC_MESSAGE,
    RPC_PERSIST_SECRET,
    RPC_RESET,
    RPC_UPDATE_FROM_BACKEND,
    SYNC_LIST,
} from '@listam/protocol'

export const CLIENT_EVENT_TYPES = Object.freeze({
    ADD_FROM_BACKEND: 'add-from-backend',
    DELETE_FROM_BACKEND: 'delete-from-backend',
    INVALID_JSON: 'invalid-json',
    INVITE_KEY: 'invite-key',
    MESSAGE: 'message',
    MESSAGE_EMPTY: 'message-empty',
    PERSIST_SECRET: 'persist-secret',
    RESET: 'reset',
    SYNC_LIST: 'sync-list',
    UNKNOWN: 'unknown',
    UPDATE_FROM_BACKEND: 'update-from-backend',
})

export const nodeClientAdapter = Object.freeze({
    name: 'node',
    encodeData(value) {
        return encodePayload(value)
    },
})

export const workletClientAdapter = Object.freeze({
    name: 'worklet',
    encodeData(value) {
        return b4a.from(encodePayload(value))
    },
})

export function decodeWithClientAdapter(adapter, command, payload) {
    return decodeBackendRequest(command, adapter.encodeData(payload))
}

export function decodeBackendRequest(requestOrCommand, data) {
    const command = typeof requestOrCommand === 'object'
        ? requestOrCommand.command
        : requestOrCommand
    const requestData = typeof requestOrCommand === 'object'
        ? requestOrCommand.data
        : data

    switch (command) {
        case RPC_PERSIST_SECRET:
            return {
                type: CLIENT_EVENT_TYPES.PERSIST_SECRET,
                payload: dataToString(requestData),
            }
        case RPC_MESSAGE:
            return decodeMessage(command, requestData)
        case RPC_RESET:
            return {
                type: CLIENT_EVENT_TYPES.RESET,
            }
        case SYNC_LIST:
            return decodeJsonField(command, requestData, CLIENT_EVENT_TYPES.SYNC_LIST, 'items')
        case RPC_DELETE_FROM_BACKEND:
            return decodeJsonField(command, requestData, CLIENT_EVENT_TYPES.DELETE_FROM_BACKEND, 'item')
        case RPC_UPDATE_FROM_BACKEND:
            return decodeJsonField(command, requestData, CLIENT_EVENT_TYPES.UPDATE_FROM_BACKEND, 'item')
        case RPC_ADD_FROM_BACKEND:
            return decodeJsonField(command, requestData, CLIENT_EVENT_TYPES.ADD_FROM_BACKEND, 'item')
        case RPC_GET_KEY:
            return {
                type: CLIENT_EVENT_TYPES.INVITE_KEY,
                key: dataToString(requestData),
            }
        default:
            return {
                type: CLIENT_EVENT_TYPES.UNKNOWN,
                command,
                data: dataToString(requestData),
            }
    }
}

export function encodePayload(value) {
    if (typeof value === 'string') return value
    return JSON.stringify(value)
}

// In-process duplex between a UI and an embedded @listam/backend — the desktop
// IPC contract. Where mobile bridges the same RPC command surface over BareKit
// IPC, a Pear Desktop app runs the backend in-process, so the "transport" is a
// pair of plain function calls:
//
//   - channel.platform.createRpc is handed to startBackend; backend-originated
//     requests (`rpc.request(cmd).send(data)` and the awaited `.reply()` used
//     by secret persistence) surface to the UI as decoded client events.
//   - channel.client.send(command, payload) dispatches a frontend request into
//     the backend's handler, exactly like a worklet RPC request arriving.
//
// Events are decoded with the same decodeBackendRequest used by the worklet
// adapter, so both transports honor one contract.
export function createBackendChannel() {
    let backendHandler = null
    const listeners = new Set()

    // Emits one decoded event to every listener. The returned promise resolves
    // when (if ever) a listener calls event.reply — listeners may reply
    // asynchronously, so backend code awaiting `req.reply()` (the secret
    // persistence ack) gets the first reply whenever it lands; the backend's
    // own ack timeout covers events nobody answers.
    function emitBackendRequest(command, data) {
        let resolveReply
        const firstReply = new Promise((resolve) => {
            resolveReply = resolve
        })
        const event = {
            ...decodeBackendRequest(command, data),
            reply(value) {
                resolveReply(value)
            },
        }
        for (const listener of listeners) {
            listener(event)
        }
        return firstReply
    }

    const platform = {
        createRpc(handler) {
            backendHandler = handler
            return {
                request(command) {
                    let firstReply = null
                    return {
                        command,
                        send(data) {
                            firstReply = emitBackendRequest(command, dataToString(data))
                        },
                        reply() {
                            return firstReply ?? Promise.resolve(null)
                        },
                    }
                },
                close() {
                    backendHandler = null
                },
            }
        },
    }

    const client = {
        async send(command, payload) {
            if (!backendHandler) throw new Error('Backend channel is not connected')
            let replyData = null
            await backendHandler({
                command,
                data: b4a.from(encodePayload(payload ?? '')),
                reply(value) {
                    replyData = value
                },
            }, null)
            return replyData
        },
        onEvent(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        isConnected() {
            return backendHandler !== null
        },
    }

    return { platform, client }
}

export function dataToString(data) {
    if (data == null) return null
    if (typeof data === 'string') return data
    if (data instanceof Uint8Array || Array.isArray(data)) return b4a.toString(data)
    if (typeof data.toString === 'function' && data.toString !== Object.prototype.toString) {
        return data.toString()
    }
    return String(data)
}

function decodeMessage(command, data) {
    const raw = dataToString(data)
    if (raw == null) {
        return {
            type: CLIENT_EVENT_TYPES.MESSAGE_EMPTY,
        }
    }

    const parsed = parseJson(command, raw)
    if (!parsed.ok) return parsed.event

    return {
        type: CLIENT_EVENT_TYPES.MESSAGE,
        payload: parsed.value,
        raw,
    }
}

function decodeJsonField(command, data, type, fieldName) {
    const raw = dataToString(data)
    const parsed = parseJson(command, raw)
    if (!parsed.ok) return parsed.event

    return {
        type,
        [fieldName]: parsed.value,
        raw,
    }
}

function parseJson(command, raw) {
    if (raw == null || raw === '') {
        return {
            ok: false,
            event: invalidJson(command, raw, 'Missing JSON payload'),
        }
    }

    try {
        return {
            ok: true,
            value: JSON.parse(raw),
        }
    } catch (error) {
        return {
            ok: false,
            event: invalidJson(command, raw, error),
        }
    }
}

function invalidJson(command, raw, error) {
    return {
        type: CLIENT_EVENT_TYPES.INVALID_JSON,
        command,
        raw,
        error: error instanceof Error ? error.message : String(error),
    }
}
