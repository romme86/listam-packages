// Platform adapter for Pear Desktop. The Pear runtime resolves the bare-*
// module graph natively, but this factory takes every runtime binding as an
// argument (Pear global, fs/path modules, RPC factory) so it can be
// constructed — and contract-tested — outside a running Pear app too.
export function createPearPlatform({ Pear, fs, join, fileURLToPath, createRpc, storageDir, storageNamespace = 'desktop', bootstrap, bootSecretPayload = '' }) {
    if (!fs || !join) throw new Error('Pear platform requires fs and join bindings')
    if (typeof createRpc !== 'function') throw new Error('Pear platform requires a createRpc factory')

    const baseDir = storageDir ?? Pear?.config?.storage
    if (!baseDir) throw new Error('Pear platform requires a storage directory (Pear.config.storage)')

    return {
        // argv layout matches the worklet contract:
        // [baseDir, peerKeys, baseKeyHex, bootSecretPayload]
        argv: [String(baseDir), '', '', bootSecretPayload],
        fs,
        join,
        fileURLToPath: fileURLToPath ?? ((value) => value),
        // Desktop is a user-facing app: corruption recovery may offer the
        // owner-confirmed destructive reset, exactly like mobile.
        recoveryPolicy: 'interactive',
        storageNamespace,
        bootstrap,
        createRpc,
        onTeardown(handler) {
            if (typeof Pear?.teardown === 'function') {
                Pear.teardown(handler)
                return undefined
            }
            return undefined
        },
    }
}
