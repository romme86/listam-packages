// Node BLE-central transport for @listam/provisioning, built on @abandonware/noble.
//
// This file is an OPTIONAL subpath: the core package depends on nothing, and
// `@abandonware/noble` is a native (node-gyp) addon that fails to load on hosts
// without a Bluetooth radio / build toolchain. So noble is imported lazily and
// the loader throws a typed `ble-unavailable` error the caller can catch and
// degrade gracefully (e.g. headless returns { ok: false, reason: 'ble-unavailable' }).
//
// Consumers (the noble addon is NOT a dependency of this package — the host app
// declares it, e.g. listam-headless as an optionalDependency):
//   const { openLeafTransport } = await import('@listam/provisioning/transport/noble')
//   const t = await openLeafTransport()
//   await provisionLeaf({ transport: t, payload })
//   await t.close()

import {
    SERVICE_UUID,
    CHAR_CONFIG_UUID,
    CHAR_STATUS_UUID,
    ADVERTISED_NAME_PREFIX,
    DEFAULT_MTU,
} from '../index.mjs'

// noble uses lowercase hex UUIDs with no dashes.
const bare = (uuid) => uuid.replace(/-/g, '').toLowerCase()

async function loadNoble() {
    try {
        const mod = await import('@abandonware/noble')
        return mod.default ?? mod
    } catch (err) {
        try {
            const mod = await import('noble')
            return mod.default ?? mod
        } catch {
            const e = new Error(
                'Bluetooth is unavailable: install the optional @abandonware/noble dependency and ensure a BLE radio is present',
            )
            e.code = 'ble-unavailable'
            e.cause = err
            throw e
        }
    }
}

function waitForPoweredOn(noble, signal) {
    if (noble.state === 'poweredOn') return Promise.resolve()
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            noble.removeListener('stateChange', onState)
            signal.removeEventListener('abort', onAbort)
        }
        const onAbort = () => { cleanup(); reject(new Error('BLE adapter not ready')) }
        const onState = (state) => {
            if (state === 'poweredOn') { cleanup(); resolve() }
        }
        noble.on('stateChange', onState)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
    })
}

function scanForLeaf(noble, { serviceUuid, namePrefix, signal }) {
    return new Promise((resolve, reject) => {
        const wanted = bare(serviceUuid)
        let settled = false
        const finish = (error, peripheral) => {
            if (settled) return
            settled = true
            noble.removeListener('discover', onDiscover)
            signal.removeEventListener('abort', onAbort)
            Promise.resolve().then(() => noble.stopScanningAsync()).catch(() => {})
            if (error) reject(error)
            else resolve(peripheral)
        }
        const onAbort = () => finish(new Error('no listam leaf found in provisioning mode'))
        const onDiscover = (peripheral) => {
            const adv = peripheral.advertisement || {}
            const services = (adv.serviceUuids || []).map((u) => u.toLowerCase())
            if (services.includes(wanted) || (adv.localName || '').startsWith(namePrefix)) finish(null, peripheral)
        }
        noble.on('discover', onDiscover)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) { onAbort(); return }
        noble.startScanningAsync([wanted], false).catch(() => {
            // A rejection after timeout must not restart discovery.
            if (!settled) return noble.startScanningAsync([], false)
        }).catch((error) => finish(error))
    })
}

// Scan for a leaf advertising the provisioning service, connect, and return a
// connected transport implementing the @listam/provisioning transport contract.
export async function openLeafTransport({
    serviceUuid = SERVICE_UUID,
    namePrefix = ADVERTISED_NAME_PREFIX,
    timeoutMs = 20000,
    logger = console,
    noble: adapter,
} = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive')
    const noble = adapter ?? await loadNoble()
    const controller = new AbortController()
    let peripheral
    let active = true
    const subscriptions = new Set()
    const release = () => {
        active = false
        for (const off of subscriptions) off()
        Promise.resolve().then(() => noble.stopScanningAsync()).catch(() => {})
        if (peripheral) Promise.resolve().then(() => peripheral.disconnectAsync()).catch(() => {})
    }
    let timer
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
            release()
            reject(new Error('BLE connection timed out'))
            controller.abort()
        }, timeoutMs)
    })
    const step = (operation) => Promise.race([operation, expired])
    try {
        await step(waitForPoweredOn(noble, controller.signal))

        logger?.log?.('[provision] scanning for a leaf in provisioning mode…')
        peripheral = await step(scanForLeaf(noble, { serviceUuid, namePrefix, signal: controller.signal }))
        const id = peripheral.id
        const name = peripheral.advertisement?.localName || `${namePrefix}-?`
        logger?.log?.(`[provision] connecting to ${name} (${id})…`)

        await step(peripheral.connectAsync().then(() => {
            if (!active) return peripheral.disconnectAsync().catch(() => {})
        }))
        if (typeof peripheral.requestMtuAsync === 'function') {
            try {
                await step(peripheral.requestMtuAsync(247))
            } catch {
                if (!active) throw new Error('BLE connection timed out')
                /* keep negotiated/default MTU */
            }
        }

        const { characteristics } = await step(peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [bare(serviceUuid)],
            [bare(CHAR_CONFIG_UUID), bare(CHAR_STATUS_UUID)],
        ))
        const configChar = characteristics.find((c) => c.uuid === bare(CHAR_CONFIG_UUID))
        const statusChar = characteristics.find((c) => c.uuid === bare(CHAR_STATUS_UUID))
        if (!configChar || !statusChar) {
            throw new Error('leaf is missing the expected provisioning characteristics')
        }

        const attMtu = typeof peripheral.mtu === 'number' ? peripheral.mtu : 23
        const mtu = Math.max(DEFAULT_MTU, attMtu - 3)

        return {
            id,
            name,
            mtu,
            async write(charUuid, bytes) {
                if (!active) throw new Error('BLE transport is closed')
                if (bare(charUuid) !== bare(CHAR_CONFIG_UUID)) {
                    throw new Error(`unexpected write target ${charUuid}`)
                }
                // write-with-response (withoutResponse=false) for ordered, reliable delivery.
                await configChar.writeAsync(Buffer.from(bytes), false)
            },
            async subscribe(charUuid, onValue) {
                if (!active) throw new Error('BLE transport is closed')
                if (bare(charUuid) !== bare(CHAR_STATUS_UUID)) {
                    throw new Error(`unexpected subscribe target ${charUuid}`)
                }
                const listener = (data) => onValue(new Uint8Array(data))
                const off = () => {
                    subscriptions.delete(off)
                    statusChar.removeListener('data', listener)
                    Promise.resolve().then(() => statusChar.unsubscribeAsync()).catch(() => {})
                }
                subscriptions.add(off)
                statusChar.on('data', listener)
                try { await statusChar.subscribeAsync() } catch (error) {
                    off()
                    throw error
                }
                if (!active) {
                    off()
                    throw new Error('BLE transport is closed')
                }
                return off
            },
            async close() {
                release()
            },
        }
    } catch (error) {
        release()
        throw error
    } finally {
        clearTimeout(timer)
        controller.abort()
    }
}
