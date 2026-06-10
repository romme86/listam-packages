import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function createNodePlatform(options = {}) {
    const sent = options.sent ?? []
    const reply = options.reply ?? (() => JSON.stringify({ stored: false, mode: 'node-memory' }))

    return {
        argv: options.argv ?? [],
        fs: options.fs ?? fs,
        join: options.join ?? join,
        fileURLToPath: options.fileURLToPath ?? fileURLToPath,
        // Node hosts are headless/server contexts by default: corruption
        // recovery never offers a destructive reset unless explicitly opted in.
        recoveryPolicy: options.recoveryPolicy ?? 'refuse-destructive',
        storageNamespace: options.storageNamespace,
        leaseTtlMs: options.leaseTtlMs,
        bootstrap: options.bootstrap,
        sent,
        createRpc: options.createRpc ?? ((handler) => createNodeRpc(handler, sent, reply)),
        onTeardown(handler) {
            if (typeof options.onTeardown === 'function') {
                return options.onTeardown(handler)
            }
            process.once('beforeExit', handler)
            return () => process.off('beforeExit', handler)
        },
    }
}

export function createNodeRpc(handler, sent = [], reply = () => null) {
    if (!handler) throw new Error('A request handler is required')

    return {
        sent,
        handler,
        request(command) {
            return {
                command,
                send(data) {
                    sent.push({ command, data })
                },
                reply() {
                    return Promise.resolve(reply(command))
                },
            }
        },
        async dispatch(command, data, error) {
            let replyData = null
            const req = {
                command,
                data: normalizeRpcData(data),
                reply(data) {
                    replyData = data
                },
            }
            await handler(req, error)
            return replyData
        },
        close() {},
    }
}

function normalizeRpcData(data) {
    if (data == null) return Buffer.alloc(0)
    if (Buffer.isBuffer(data)) return data
    if (data instanceof Uint8Array) return Buffer.from(data)
    return Buffer.from(String(data))
}
