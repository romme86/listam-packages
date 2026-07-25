import Protomux from 'protomux'
import c from 'compact-encoding'

export const EPOCH_GRANT_PROTOCOL = 'listam/epoch-grant/1'

let nextRequestId = 0

// Authenticated transport for recovery grants. Hyperswarm's connection is a
// Noise secret stream; Protomux lets this control exchange coexist with
// Autobase replication without writing unframed bytes into the replication
// protocol. The record itself remains owner-signed and each key remains sealed
// to a registered writer epoch key, so the transport is not an authority.
export function createEpochGrantChannel(stream, {
    onGrant,
    timeoutMs = 2500,
    logger = null,
    onClose = null,
} = {}) {
    if (!stream || typeof onGrant !== 'function') return null

    const mux = Protomux.from(stream)
    let opened = false
    let closed = false
    let resolveOpen
    const openPromise = new Promise((resolve) => { resolveOpen = resolve })
    const pending = new Map()

    const channel = mux.createChannel({
        protocol: EPOCH_GRANT_PROTOCOL,
        onopen() {
            opened = true
            resolveOpen(true)
        },
        onclose() {
            finishClose()
        },
        ondestroy() {
            finishClose()
        },
    })
    if (!channel) return null

    const grantMessage = channel.addMessage({
        encoding: c.string,
        async onmessage(raw) {
            let envelope = null
            let ok = false
            try {
                envelope = JSON.parse(raw)
                if (typeof envelope?.id === 'string' && envelope.record) {
                    ok = await onGrant(envelope.record) === true
                }
            } catch (error) {
                logger?.log?.('[WARNING] Invalid direct epoch grant message', error)
            }
            if (!closed && typeof envelope?.id === 'string') {
                ackMessage.send(JSON.stringify({ id: envelope.id, ok }))
            }
        },
    })
    const ackMessage = channel.addMessage({
        encoding: c.string,
        onmessage(raw) {
            try {
                const ack = JSON.parse(raw)
                const finish = pending.get(ack?.id)
                if (finish) finish(ack.ok === true)
            } catch {}
        },
    })

    channel.open()

    return {
        get opened() { return opened && !closed },
        async sendGrant(record) {
            if (!record || closed) return false
            if (!opened && !(await waitWithTimeout(openPromise, timeoutMs))) return false

            const id = `${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`
            return new Promise((resolve) => {
                let settled = false
                const timer = setTimeout(() => finish(false), timeoutMs)
                const finish = (ok) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    pending.delete(id)
                    resolve(ok === true)
                }
                pending.set(id, finish)
                try {
                    grantMessage.send(JSON.stringify({ id, record }))
                } catch {
                    finish(false)
                }
            })
        },
        close() {
            if (!closed) channel.close()
            finishClose()
        },
    }

    function finishClose() {
        if (closed) return
        closed = true
        resolveOpen(false)
        for (const finish of pending.values()) finish(false)
        pending.clear()
        onClose?.()
    }
}

function waitWithTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false
        const timer = setTimeout(() => finish(false), timeoutMs)
        const finish = (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value === true)
        }
        promise.then(finish, () => finish(false))
    })
}
