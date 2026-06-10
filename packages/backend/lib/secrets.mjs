import { RPC_PERSIST_SECRET } from '@listam/protocol'
import {
    createDeleteSecretPayload,
    createPersistSecretPayload,
    getBackendSecretValue,
    normalizeSecretValue,
    parseBackendSecretPayload,
    parseSecretAck,
    secretFingerprint,
} from '@listam/secrets'
import { rpc } from './state.mjs'
import { logger } from './logger.mjs'

const PERSIST_ACK_TIMEOUT_MS = 8000
const PERSIST_RETRIES = 2

export { normalizeSecretValue, secretFingerprint }

export function parseBootSecretPayload(rawPayload) {
    return parseBackendSecretPayload(rawPayload, { logger })
}

export function getBootSecretBuffer(bootSecrets, name) {
    const value = getBackendSecretValue(bootSecrets, name)
    return value ? Buffer.from(value, 'hex') : null
}

// Persist a secret through the platform adapter and wait for an acknowledgement
// that it was durably stored. Returns true only when the frontend confirms a
// secure-store write, so the caller can safely retire the plaintext copy.
export function persistBackendSecret(name, value) {
    const payload = createPersistSecretPayload(name, value)
    if (!payload) {
        logger.log('[ERROR] Refusing to persist invalid backend secret', { name })
        return Promise.resolve(false)
    }

    return sendSecretRequest(payload, PERSIST_RETRIES)
}

export function deleteBackendSecret(name) {
    const payload = createDeleteSecretPayload(name)
    if (!payload) return Promise.resolve(false)
    return sendSecretRequest(payload, 0)
}

async function sendSecretRequest(payload, retries = 0) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (!rpc) {
            logger.log('[WARNING] Secret persistence requested before RPC was ready', {
                name: payload.name,
                op: payload.op,
            })
            return false
        }

        try {
            const req = rpc.request(RPC_PERSIST_SECRET)
            req.send(JSON.stringify(payload))
            const stored = parseSecretAck(await withTimeout(req.reply(), PERSIST_ACK_TIMEOUT_MS))
            if (stored) {
                logger.log('[INFO] Backend secret persistence acknowledged', {
                    name: payload.name,
                    op: payload.op,
                    fingerprint: payload.fingerprint,
                })
                return true
            }
            logger.log('[WARNING] Backend secret persistence not durably stored', {
                name: payload.name,
                op: payload.op,
                attempt,
            })
        } catch (e) {
            logger.log('[ERROR] Failed to confirm backend secret persistence:', e)
        }
    }
    return false
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('secret persistence ack timed out')), ms)
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value) },
            (err) => { clearTimeout(timer); reject(err) },
        )
    })
}
