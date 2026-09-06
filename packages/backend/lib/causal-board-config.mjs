import messages from 'autobase/lib/messages.js'
import { configAsStamped, reduceBoardConfigOperation } from './board-config.mjs'

const keyHex = (key) => typeof key === 'string' ? key : Buffer.from(key).toString('hex')

// Legacy writers have no boardConfigSeq. Their authenticated Autobase heads
// still tell us which controls they could have seen. Follow those heads, not
// the current linearized prefix or a wall clock. Acknowledgement nodes and the
// implicit previous block of each writer matter for transitive ancestry.
export async function resolveCausalBoardConfig({ node, records, readNode, ...options }) {
    if (!Number.isSafeInteger(node.length) || node.length < 1 || !Array.isArray(node.heads)) return null
    const known = new Map(records.map((r) => [r.signature, r]))
    const highest = Math.max(0, ...records.map((r) => Number(r.sequence) || 0))
    let seenSequence = 0
    const pending = [...node.heads]
    if (node.length > 1) pending.unshift({ key: node.from.key, length: node.length - 1 })
    const visited = new Set()

    while (pending.length && seenSequence < highest) {
        const head = pending.pop()
        const key = keyHex(head.key)
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(head.length) || head.length < 1) {
            throw new Error('Invalid causal head')
        }
        const id = `${key}:${head.length}`
        if (visited.has(id)) continue
        visited.add(id)
        const ancestor = await readNode(key, head.length)
        if (!ancestor) {
            const error = new Error('Causal board history is not available locally')
            error.code = 'ERR_CAUSAL_HISTORY_UNAVAILABLE'
            throw error
        }
        const record = known.get(ancestor.value?.signature)
        if (record && reduceBoardConfigOperation(ancestor.value, undefined, options).ok) {
            seenSequence = Math.max(seenSequence, record.sequence)
            // Accepted owner config sequences are increasing. Earlier history
            // on this branch cannot increase the sequence this writer saw.
            continue
        }
        if (head.length > 1) pending.push({ key, length: head.length - 1 })
        pending.push(...(ancestor.heads ?? []))
    }
    return configAsStamped({ boardConfigSeq: seenSequence }, records, options)
}

export async function causalBoardConfig(ctx, node, records) {
    const base = ctx.autobase
    const cores = new Map()
    try {
        return await resolveCausalBoardConfig({
            node, records, baseKey: base.key,
            ownerAuthorityKey: ctx.membershipState.ownerAuthorityKey,
            readNode: async (key, length) => {
                let core = cores.get(key)
                if (!core) {
                    core = base.store.get({
                        key: Buffer.from(key, 'hex'), compat: false, writable: false,
                        active: false, valueEncoding: messages.OplogMessage,
                        encryption: base.getWriterEncryption(),
                    })
                    cores.set(key, core)
                    await core.ready()
                }
                // These are consensus ancestors, not notification hints. Never
                // guess a verdict from incomplete history or wait on a peer in
                // this local validation path.
                const message = await core.get(length - 1, { wait: false })
                if (!message?.node) return null
                const encoded = message.node.value
                const value = encoded === null ? null : base.valueEncoding.decode({
                    start: 0, end: encoded.byteLength, buffer: encoded,
                })
                return { value, heads: message.node.heads }
            },
        })
    } finally {
        await Promise.all([...cores.values()].map((core) => core.close().catch(() => {})))
    }
}
