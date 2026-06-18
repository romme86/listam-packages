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

function waitForPoweredOn(noble, timeoutMs) {
    if (noble.state === 'poweredOn') return Promise.resolve()
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            noble.removeListener('stateChange', onState)
            reject(new Error(`BLE adapter not ready (state: ${noble.state})`))
        }, timeoutMs)
        const onState = (state) => {
            if (state === 'poweredOn') {
                clearTimeout(timer)
                noble.removeListener('stateChange', onState)
                resolve()
            }
        }
        noble.on('stateChange', onState)
    })
}

function scanForLeaf(noble, { serviceUuid, namePrefix, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const wanted = bare(serviceUuid)
        const timer = setTimeout(async () => {
            noble.removeListener('discover', onDiscover)
            try {
                await noble.stopScanningAsync()
            } catch {
                /* ignore */
            }
            reject(new Error('no listam leaf found in provisioning mode'))
        }, timeoutMs)

        const onDiscover = async (peripheral) => {
            const adv = peripheral.advertisement || {}
            const services = (adv.serviceUuids || []).map((u) => u.toLowerCase())
            const name = adv.localName || ''
            const matches = services.includes(wanted) || name.startsWith(namePrefix)
            if (!matches) return
            clearTimeout(timer)
            noble.removeListener('discover', onDiscover)
            try {
                await noble.stopScanningAsync()
            } catch {
                /* ignore */
            }
            resolve(peripheral)
        }

        noble.on('discover', onDiscover)
        noble.startScanningAsync([wanted], false).catch((err) => {
            // Some platforms reject service-filtered scans; retry unfiltered.
            noble.startScanningAsync([], false).catch(reject)
            void err
        })
    })
}

// Scan for a leaf advertising the provisioning service, connect, and return a
// connected transport implementing the @listam/provisioning transport contract.
export async function openLeafTransport({
    serviceUuid = SERVICE_UUID,
    namePrefix = ADVERTISED_NAME_PREFIX,
    timeoutMs = 20000,
    logger = console,
} = {}) {
    const noble = await loadNoble()
    await waitForPoweredOn(noble, timeoutMs)

    logger?.log?.('[provision] scanning for a leaf in provisioning mode…')
    const peripheral = await scanForLeaf(noble, { serviceUuid, namePrefix, timeoutMs })
    const id = peripheral.id
    const name = peripheral.advertisement?.localName || `${namePrefix}-?`
    logger?.log?.(`[provision] connecting to ${name} (${id})…`)

    await peripheral.connectAsync()
    if (typeof peripheral.requestMtuAsync === 'function') {
        try {
            await peripheral.requestMtuAsync(247)
        } catch {
            /* keep negotiated/default MTU */
        }
    }

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [bare(serviceUuid)],
        [bare(CHAR_CONFIG_UUID), bare(CHAR_STATUS_UUID)],
    )
    const configChar = characteristics.find((c) => c.uuid === bare(CHAR_CONFIG_UUID))
    const statusChar = characteristics.find((c) => c.uuid === bare(CHAR_STATUS_UUID))
    if (!configChar || !statusChar) {
        await peripheral.disconnectAsync().catch(() => {})
        throw new Error('leaf is missing the expected provisioning characteristics')
    }

    const attMtu = typeof peripheral.mtu === 'number' ? peripheral.mtu : 23
    const mtu = Math.max(DEFAULT_MTU, attMtu - 3)

    return {
        id,
        name,
        mtu,
        async write(charUuid, bytes) {
            if (bare(charUuid) !== bare(CHAR_CONFIG_UUID)) {
                throw new Error(`unexpected write target ${charUuid}`)
            }
            // write-with-response (withoutResponse=false) for ordered, reliable delivery.
            await configChar.writeAsync(Buffer.from(bytes), false)
        },
        async subscribe(charUuid, onValue) {
            if (bare(charUuid) !== bare(CHAR_STATUS_UUID)) {
                throw new Error(`unexpected subscribe target ${charUuid}`)
            }
            const listener = (data) => onValue(new Uint8Array(data))
            statusChar.on('data', listener)
            await statusChar.subscribeAsync()
            return async () => {
                statusChar.removeListener('data', listener)
                try {
                    await statusChar.unsubscribeAsync()
                } catch {
                    /* link may be gone after the leaf reboots */
                }
            }
        },
        async close() {
            try {
                await peripheral.disconnectAsync()
            } catch {
                /* already disconnected (e.g. leaf rebooted on success) */
            }
        },
    }
}
