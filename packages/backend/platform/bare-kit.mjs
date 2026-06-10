import RPC from 'bare-rpc'
import URL from 'bare-url'
import { join } from 'bare-path'
import fs from 'bare-fs'

export function createBareKitPlatform({ Bare, BareKit }) {
    if (!BareKit?.IPC) throw new Error('BareKit IPC is required')
    return {
        argv: Array.isArray(Bare?.argv) ? Bare.argv : [],
        fs,
        join,
        fileURLToPath: URL.fileURLToPath,
        // The worklet runs under a user-facing app, so corruption recovery can
        // offer an owner-confirmed destructive reset. Headless nodes must use
        // 'refuse-destructive' (the backend default).
        recoveryPolicy: 'interactive',
        createRpc(handler) {
            return new RPC(BareKit.IPC, handler)
        },
        onTeardown(handler) {
            Bare?.on?.('teardown', handler)
        },
    }
}
