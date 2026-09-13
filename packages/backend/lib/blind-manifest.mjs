import b4a from 'b4a'

export const MAX_MIRROR_CORES = 4096
const HEX = /^[0-9a-f]{64}$/

export function normalizeMirrorManifest(value) {
    if (!value || value.version !== 1 || !HEX.test(value.baseKey ?? '') ||
        Object.keys(value).some((key) => !['version', 'baseKey', 'revision', 'keys'].includes(key)) ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        !Array.isArray(value.keys) || value.keys.length > MAX_MIRROR_CORES ||
        !value.keys.every((key) => typeof key === 'string' && HEX.test(key))) {
        throw new Error('invalid-mirror-manifest')
    }
    // Copy only public metadata. Never persist arbitrary signed payload fields.
    return { version: 1, baseKey: value.baseKey, revision: value.revision, keys: [...new Set(value.keys)].sort() }
}

export function collectMirrorKeys(ctx) {
    const base = ctx?.autobase
    if (!base?.opened || base.closing) return null
    const keys = new Set()
    function add(value) {
        const key = typeof value === 'string' ? value : value ? b4a.toString(value, 'hex') : ''
        if (HEX.test(key)) keys.add(key)
    }
    add(base.key)
    add(base.local?.key)
    add(base.core?.key)
    add(base.view?.key)
    for (const writer of base.activeWriters ?? []) add(writer?.core?.key ?? writer?.key)
    for (const key of ctx.knownWriters ?? []) add(key)
    for (const key of ctx.membershipState?.writers ?? []) add(key)
    for (const key of ctx.membershipState?.removedWriters?.keys?.() ?? []) add(key)
    if (keys.size > MAX_MIRROR_CORES) throw new Error('mirror-core-limit')
    return [...keys].sort()
}

export function writeMirrorState(fs, path, value) {
    const temp = `${path}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    // Flush the file before publishing the new revision. Native/Bare fs
    // adapters support the same descriptor operations as Node.
    const fd = fs.openSync(temp, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, path)
}
