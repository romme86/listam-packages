import { collectMirrorKeys, normalizeMirrorManifest, writeMirrorState } from './blind-manifest.mjs'

// One explicit subscription per helper/base. Revisions are persisted before
// sending and retries reuse the same revision, including across restarts.
export function createBlindMirrorPublisher({ fs, path, getContext, send, isSuspended = () => false, onError = () => {}, intervalMs = 15000 }) {
    let records = []
    try {
        const saved = JSON.parse(fs.readFileSync(path, 'utf8'))
        if (saved.version !== 1 || !Array.isArray(saved.records) || saved.records.length > 32) throw new Error('invalid mirror subscriptions')
        const seen = new Set()
        records = saved.records.map((record) => {
            if (!/^[0-9a-f]{64}$/.test(record.serverKey ?? '')) throw new Error('invalid mirror helper')
            const manifest = normalizeMirrorManifest(record.manifest)
            const id = `${record.serverKey}:${manifest.baseKey}`
            if (seen.has(id) || typeof record.enabled !== 'boolean') throw new Error('invalid mirror subscription')
            seen.add(id)
            return { serverKey: record.serverKey, enabled: record.enabled, acknowledged: 0, manifest }
        })
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    let stopped = false
    let queue = Promise.resolve()
    const persist = () => writeMirrorState(fs, path, { version: 1, records })
    const enqueue = (fn) => {
        const result = queue.then(fn)
        queue = result.catch(() => {})
        return result
    }
    async function refresh(record, force = false) {
        if (stopped || isSuspended()) return { ok: false, reason: 'suspended' }
        if (record.enabled) {
            const current = collectMirrorKeys(getContext(record.manifest.baseKey))
            if (!current) return { ok: false, reason: 'base-unavailable' }
            // Keep historical writers/view generations for causal recovery.
            const keys = [...new Set([...record.manifest.keys, ...current])].sort()
            if (JSON.stringify(keys) !== JSON.stringify(record.manifest.keys)) {
                record.manifest = normalizeMirrorManifest({ ...record.manifest, revision: record.manifest.revision + 1, keys })
                persist()
            }
        }
        if (!force && record.acknowledged === record.manifest.revision) return { ok: true }
        persist()
        const result = await send(record.serverKey, 'topics', { action: 'manifest', manifest: record.manifest })
        if (result?.ok) record.acknowledged = record.manifest.revision
        return result
    }
    async function tick() {
        if (stopped || isSuspended()) return
        // Failed/unavailable helpers do not prevent the next subscription.
        await Promise.all(records.map(async (record) => {
            try { await refresh(record) } catch (error) { onError(error) }
        }))
    }
    let tickPending = false
    const timer = setInterval(() => {
        if (tickPending || stopped) return
        tickPending = true
        void enqueue(tick).finally(() => { tickPending = false }).catch(onError)
    }, intervalMs)
    timer.unref?.()
    return {
        configure(serverKey, baseKey, enabled = true) {
            return enqueue(async () => {
                if (!/^[0-9a-f]{64}$/.test(serverKey ?? '') || !/^[0-9a-f]{64}$/.test(baseKey ?? '')) return { ok: false, reason: 'invalid-mirror-target' }
                if (enabled && !collectMirrorKeys(getContext(baseKey))) return { ok: false, reason: 'base-unavailable' }
                let record = records.find((r) => r.serverKey === serverKey && r.manifest.baseKey === baseKey)
                if (!record) {
                    if (!enabled) return { ok: true }
                    if (records.length >= 32) return { ok: false, reason: 'mirror-subscription-limit' }
                    record = { serverKey, enabled, acknowledged: 0, manifest: { version: 1, baseKey, revision: 1, keys: [] } }
                    records.push(record)
                } else if (record.enabled !== enabled) {
                    record.enabled = enabled
                    record.manifest = { ...record.manifest, revision: record.manifest.revision + 1, keys: [] }
                }
                persist()
                return refresh(record, true)
            })
        },
        refresh: () => enqueue(tick),
        stop() { stopped = true; clearInterval(timer) },
    }
}
