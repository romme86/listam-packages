export const SECRET_PAYLOAD_VERSION = 1

export const SECRET_STORE_KEY_PREFIX = 'listam.secret.v1.'
export const SECRET_METADATA_KEY = `${SECRET_STORE_KEY_PREFIX}metadata`
export const LEGACY_LOYALTY_CARDS_KEY = '@lista_loyalty_cards'
export const LOYALTY_CARD_HANDLES_KEY = '@lista_loyalty_card_handles'
export const LOYALTY_CARD_PAYLOAD_KEY_PREFIX = `${SECRET_STORE_KEY_PREFIX}loyalty-card.`
export const LOYALTY_CARD_METADATA_KEY = `${SECRET_STORE_KEY_PREFIX}loyalty-card-metadata`

export const SECURE_SECRET_FILES = {
    autobaseKey: 'lista-autobase-key.txt',
    encryptionKey: 'lista-encryption-key.txt',
    ownerAuthorityKey: 'lista-owner-authority-key.txt',
    epochKey: 'lista-epoch-key.txt',
    epochEncryptionKey: 'lista-epoch-encryption-key.txt',
}

export const LEGACY_CLEANUP_FILES = {
    localWriterKey: 'lista-local-writer-key.txt',
    pairingInvite: 'lista-invite.json',
}

export const LEGACY_SECRET_FILES = {
    ...SECURE_SECRET_FILES,
    ...LEGACY_CLEANUP_FILES,
}

export const SECRET_NAMES = Object.freeze(Object.keys(SECURE_SECRET_FILES))
export const BACKEND_SECRET_NAMES = Object.freeze([
    'autobaseKey',
    'encryptionKey',
    'ownerAuthorityKey',
    'epochKey',
    'epochEncryptionKey',
])

export const HEX_SECRET_BYTES = Object.freeze({
    autobaseKey: 32,
    encryptionKey: 32,
    ownerAuthorityKey: 64,
    epochKey: 32,
    epochEncryptionKey: 32,
    // This device's owner-control identity seed: lets the mobile app pair with
    // and command the user's headless instances (Phase 14/15). Service
    // material, independent of any list keys.
    controlDeviceSeed: 32,
})

const CLEANUP_FILES = Object.values(LEGACY_CLEANUP_FILES)
const HEX = /^[0-9a-f]+$/i
const SAFE_STORAGE_SEGMENT = /[^A-Za-z0-9._-]/g

export function secretStoreKey(name) {
    return `${SECRET_STORE_KEY_PREFIX}${name}`
}

export function loyaltyCardPayloadRef(id) {
    const segment = normalizeStorageSegment(id)
    return segment ? `card.${segment}` : ''
}

export function loyaltyCardPayloadStoreKey(payloadRef) {
    const ref = normalizeLoyaltyCardPayloadRef(payloadRef)
    return ref ? `${LOYALTY_CARD_PAYLOAD_KEY_PREFIX}${ref}` : null
}

export function normalizeLoyaltyCardPayload(raw) {
    const value = parseJsonIfString(raw)
    if (!value || typeof value !== 'object') return null

    const id = normalizeNonEmptyString(value.id)
    const name = normalizeNonEmptyString(value.name)
    const data = normalizeNonEmptyString(value.data ?? value.payload)
    if (!id || !name || !data) return null

    return {
        id,
        name,
        type: normalizeNonEmptyString(value.type) || 'unknown',
        data,
    }
}

export function normalizeLoyaltyCardHandle(raw) {
    const value = parseJsonIfString(raw)
    if (!value || typeof value !== 'object') return null

    const id = normalizeNonEmptyString(value.id)
    const name = normalizeNonEmptyString(value.name)
    if (!id || !name) return null

    return {
        id,
        name,
        type: normalizeNonEmptyString(value.type) || 'unknown',
        payloadRef: normalizeLoyaltyCardPayloadRef(value.payloadRef) || loyaltyCardPayloadRef(id),
    }
}

export function toLoyaltyCardHandle(card) {
    const payload = normalizeLoyaltyCardPayload(card)
    if (payload) {
        return {
            id: payload.id,
            name: payload.name,
            type: payload.type,
            payloadRef: loyaltyCardPayloadRef(payload.id),
        }
    }

    return normalizeLoyaltyCardHandle(card)
}

export function parseLoyaltyCardPayloadList(raw) {
    const parsed = parseJsonIfString(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
        .map(normalizeLoyaltyCardPayload)
        .filter(Boolean)
}

export function parseLoyaltyCardHandleList(raw) {
    const parsed = parseJsonIfString(raw)
    if (!Array.isArray(parsed)) return []
    return dedupeLoyaltyCardHandles(parsed.map(normalizeLoyaltyCardHandle).filter(Boolean))
}

export function serializeLoyaltyCardHandles(handles) {
    return JSON.stringify(dedupeLoyaltyCardHandles(handles).map((handle) => ({
        id: handle.id,
        name: handle.name,
        type: handle.type,
        payloadRef: handle.payloadRef,
    })))
}

export function normalizeSecretValue(name, raw) {
    const bytes = HEX_SECRET_BYTES[name]
    if (!bytes) return null

    if (isBytes(raw)) {
        return normalizeHex(bytesToHex(raw), bytes)
    }

    if (typeof raw === 'string') {
        return normalizeHex(raw, bytes)
    }

    return null
}

export function parseSecretName(raw) {
    // HEX_SECRET_BYTES is the authoritative set of hex secrets; SECRET_NAMES
    // (the file-backed subset) is included for completeness. controlDeviceSeed
    // is hex-only with no legacy file, so it qualifies via HEX_SECRET_BYTES.
    if (typeof raw !== 'string') return null
    return raw in HEX_SECRET_BYTES || SECRET_NAMES.includes(raw) ? raw : null
}

export function secretFingerprint(value) {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

export function emptyBackendSecretPayload() {
    return { version: SECRET_PAYLOAD_VERSION, mode: 'none', secrets: {} }
}

export function parseBackendSecretPayload(rawPayload, options = {}) {
    const empty = emptyBackendSecretPayload()
    if (!rawPayload || typeof rawPayload !== 'string') return empty

    try {
        const parsed = JSON.parse(rawPayload)
        const secrets = {}
        for (const name of BACKEND_SECRET_NAMES) {
            const value = normalizeSecretValue(name, parsed?.secrets?.[name])
            if (value) secrets[name] = value
        }
        options.logger?.log?.('[INFO] Backend boot secrets received', {
            mode: parsed?.mode || 'unknown',
            fingerprints: fingerprintsFor(secrets),
        })
        return {
            version: Number(parsed?.version) || SECRET_PAYLOAD_VERSION,
            mode: parsed?.mode || 'unknown',
            secrets,
        }
    } catch (e) {
        options.logger?.log?.('[ERROR] Failed to parse backend boot secret payload:', e)
        return empty
    }
}

export function getBackendSecretValue(bootSecrets, name) {
    return normalizeSecretValue(name, bootSecrets?.secrets?.[name])
}

export function createPersistSecretPayload(name, value) {
    const normalized = normalizeSecretValue(name, value)
    if (!normalized) return null
    return {
        version: SECRET_PAYLOAD_VERSION,
        op: 'set',
        name,
        value: normalized,
        fingerprint: secretFingerprint(normalized),
    }
}

export function createDeleteSecretPayload(name) {
    if (!parseSecretName(name)) return null
    return {
        version: SECRET_PAYLOAD_VERSION,
        op: 'delete',
        name,
    }
}

export function parseSecretAck(ack) {
    try {
        const text = ack == null
            ? ''
            : typeof ack === 'string'
                ? ack
                : bytesToUtf8(ack)
        return text ? JSON.parse(text)?.stored === true : false
    } catch {
        return false
    }
}

export async function prepareBackendSecrets(adapters) {
    const warnings = []
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)
    const secureSecrets = secureStorageAvailable
        ? await readSecureSecrets(adapters.secureStore, warnings)
        : {}
    const legacySecrets = adapters.legacyFiles
        ? await readLegacySecrets(adapters.legacyFiles, warnings)
        : {}

    if (secureStorageAvailable && adapters.legacyFiles) {
        await migrateLegacySecrets({
            secureStore: adapters.secureStore,
            legacyFiles: adapters.legacyFiles,
            legacySecrets,
            secureSecrets,
            warnings,
        })
    }

    if (adapters.legacyFiles) {
        await deleteCleanupFiles(adapters.legacyFiles, warnings)
    }

    const memorySecrets = adapters.memoryStore?.snapshot() ?? {}
    if (secureStorageAvailable) {
        await flushMemorySecrets(adapters.secureStore, adapters.memoryStore, memorySecrets, secureSecrets, warnings)
    }

    const effectiveSecrets = secureStorageAvailable
        ? secureSecrets
        : {
            ...legacySecrets,
            ...memorySecrets,
        }

    const mode = secureStorageAvailable
        ? 'secure-store'
        : Object.keys(legacySecrets).length > 0
            ? 'plaintext-recovery'
            : 'memory-recovery'

    await writeSecretMetadata(adapters.metadataStore, mode, effectiveSecrets, warnings)

    return {
        backendPayload: {
            version: SECRET_PAYLOAD_VERSION,
            mode,
            secrets: pickBackendSecrets(effectiveSecrets),
        },
        mode,
        secureStorageAvailable,
        warnings,
    }
}

export async function persistBackendSecretRequest(rawRequest, adapters) {
    const request = parsePersistRequest(rawRequest)
    const name = parseSecretName(request.name)
    if (!name) throw new Error('Invalid secret name')

    const op = request.op === 'delete' || request.value == null ? 'delete' : 'set'
    const warnings = []
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)

    if (op === 'delete') {
        if (secureStorageAvailable) {
            await adapters.secureStore.deleteItem?.(secretStoreKey(name))
        }
        adapters.memoryStore?.delete(name)
        await writeSecretMetadata(adapters.metadataStore, secureStorageAvailable ? 'secure-store' : 'memory-recovery', {}, warnings)
        return { mode: secureStorageAvailable ? 'secure-store' : 'memory-recovery' }
    }

    const value = normalizeSecretValue(name, request.value)
    if (!value) throw new Error('Invalid secret value')

    if (secureStorageAvailable) {
        await writeAndConfirmSecret(adapters.secureStore, name, value)
        adapters.memoryStore?.delete(name)
        await writeSecretMetadata(adapters.metadataStore, 'secure-store', { [name]: value }, warnings)
        return { mode: 'secure-store' }
    }

    adapters.memoryStore?.set(name, value)
    await writeSecretMetadata(adapters.metadataStore, 'memory-recovery', { [name]: value }, warnings)
    return {
        mode: 'memory-recovery',
        warning: 'Secure storage is unavailable; key material is only cached for this app session.',
    }
}

export async function prepareLoyaltyCardPayloads(adapters) {
    const warnings = []
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)
    const storedHandles = adapters.handleStore
        ? await readStoredLoyaltyCardHandles(adapters.handleStore, warnings)
        : []
    const legacyPayloads = adapters.legacyStore
        ? await readLegacyLoyaltyCardPayloads(adapters.legacyStore, warnings)
        : []

    let handles = dedupeLoyaltyCardHandles(storedHandles)
    let migratedCount = 0
    let migrationComplete = true

    if (secureStorageAvailable) {
        for (const payload of legacyPayloads) {
            const handle = toLoyaltyCardHandle(payload)
            try {
                await writeAndConfirmLoyaltyCardPayload(adapters.secureStore, handle, payload)
                handles = upsertLoyaltyCardHandle(handles, handle)
                migratedCount += 1
            } catch {
                migrationComplete = false
                warnings.push(`Loyalty-card payload migration failed for ${payload.id}.`)
            }
        }

        if (adapters.handleStore) {
            await writeStoredLoyaltyCardHandles(adapters.handleStore, handles, warnings)
        }
        if (legacyPayloads.length > 0 && migrationComplete && adapters.legacyStore?.removeItem) {
            try {
                await adapters.legacyStore.removeItem(LEGACY_LOYALTY_CARDS_KEY)
            } catch {
                warnings.push('Legacy loyalty-card payload cleanup failed.')
            }
        }
        await writeLoyaltyCardMetadata(adapters.metadataStore, 'secure-store', handles, migratedCount, warnings)
        return {
            handles,
            mode: 'secure-store',
            secureStorageAvailable,
            migratedCount,
            warnings,
        }
    }

    if (legacyPayloads.length > 0) {
        handles = dedupeLoyaltyCardHandles([
            ...handles,
            ...legacyPayloads.map(toLoyaltyCardHandle),
        ])
        warnings.push('Secure storage is unavailable; legacy loyalty-card payloads remain pending migration.')
    }

    const mode = legacyPayloads.length > 0 ? 'legacy-recovery' : 'unavailable'
    await writeLoyaltyCardMetadata(adapters.metadataStore, mode, handles, migratedCount, warnings)
    return {
        handles,
        mode,
        secureStorageAvailable,
        migratedCount,
        warnings,
    }
}

export async function persistLoyaltyCardPayload(card, adapters) {
    const payload = normalizeLoyaltyCardPayload(card)
    if (!payload) throw new Error('Invalid loyalty-card payload')

    const warnings = []
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)
    if (!secureStorageAvailable) {
        throw new Error('Secure storage is unavailable for loyalty-card payloads')
    }

    const handle = toLoyaltyCardHandle(payload)
    await writeAndConfirmLoyaltyCardPayload(adapters.secureStore, handle, payload)

    let handles = [handle]
    if (adapters.handleStore) {
        handles = upsertLoyaltyCardHandle(
            await readStoredLoyaltyCardHandles(adapters.handleStore, warnings),
            handle,
        )
        await writeStoredLoyaltyCardHandles(
            adapters.handleStore,
            handles,
            warnings,
        )
    }
    if (adapters.legacyStore) {
        await removeLegacyLoyaltyCardPayload(adapters.legacyStore, handle.id, warnings)
    }
    await writeLoyaltyCardMetadata(adapters.metadataStore, 'secure-store', handles, 0, warnings)

    return { handle, mode: 'secure-store', warnings }
}

export async function readLoyaltyCardPayload(handleOrRef, adapters) {
    const warnings = []
    const handle = normalizeLoyaltyCardHandle(handleOrRef)
    const ref = handle?.payloadRef || normalizeLoyaltyCardPayloadRef(handleOrRef?.payloadRef || handleOrRef)
    const id = handle?.id || normalizeNonEmptyString(handleOrRef?.id)
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)

    if (secureStorageAvailable && ref) {
        try {
            const key = loyaltyCardPayloadStoreKey(ref)
            const payload = normalizeLoyaltyCardPayload(key ? await adapters.secureStore.getItem(key) : null)
            if (payload) return payload
        } catch {
            warnings.push('Loyalty-card payload secure read failed.')
        }
    }

    if (adapters.legacyStore && id) {
        const legacyPayloads = await readLegacyLoyaltyCardPayloads(adapters.legacyStore, warnings)
        return legacyPayloads.find((payload) => payload.id === id) ?? null
    }

    return null
}

export async function deleteLoyaltyCardPayload(handleOrId, adapters) {
    const warnings = []
    const handle = normalizeLoyaltyCardHandle(handleOrId)
    const id = handle?.id || normalizeNonEmptyString(handleOrId)
    const ref = handle?.payloadRef || (id ? loyaltyCardPayloadRef(id) : normalizeLoyaltyCardPayloadRef(handleOrId?.payloadRef))
    const secureStorageAvailable = await isSecureStoreAvailable(adapters.secureStore, warnings)

    if (secureStorageAvailable && ref) {
        const key = loyaltyCardPayloadStoreKey(ref)
        try {
            if (key) await adapters.secureStore.deleteItem?.(key)
        } catch {
            warnings.push('Loyalty-card payload secure deletion failed.')
        }
    }

    let remainingHandles = []
    if (adapters.handleStore) {
        const handles = await readStoredLoyaltyCardHandles(adapters.handleStore, warnings)
        remainingHandles = handles.filter((entry) => entry.id !== id && entry.payloadRef !== ref)
        await writeStoredLoyaltyCardHandles(
            adapters.handleStore,
            remainingHandles,
            warnings,
        )
    }
    if (adapters.legacyStore && id) {
        await removeLegacyLoyaltyCardPayload(adapters.legacyStore, id, warnings)
    }
    await writeLoyaltyCardMetadata(
        adapters.metadataStore,
        secureStorageAvailable ? 'secure-store' : 'legacy-recovery',
        remainingHandles,
        0,
        warnings,
    )

    return {
        mode: secureStorageAvailable ? 'secure-store' : 'legacy-recovery',
        warnings,
    }
}

// File-backed secret store with the SecureSecretStore adapter shape, for
// desktop/headless hosts that have no platform keychain bridge yet. All
// values live in one owner-only (0600) JSON file under the app's private
// storage directory — the documented dev/file tier; OS keychain/keyring
// integration is the planned upgrade. The fs module is injected so node:fs
// and bare-fs both work.
export function createFileSecretStore({ fs, path }) {
    if (!fs || !path) throw new Error('A filesystem adapter and file path are required')

    function readAll() {
        try {
            const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
            return {}
        }
    }

    function writeAll(values) {
        fs.writeFileSync(path, JSON.stringify(values), { mode: 0o600 })
    }

    return {
        async isAvailable() {
            return true
        },
        async getItem(key) {
            const values = readAll()
            return typeof values[key] === 'string' ? values[key] : null
        },
        async setItem(key, value) {
            const values = readAll()
            values[key] = String(value)
            writeAll(values)
        },
        async deleteItem(key) {
            const values = readAll()
            if (!(key in values)) return
            delete values[key]
            writeAll(values)
        },
    }
}

function parsePersistRequest(rawRequest) {
    if (typeof rawRequest !== 'string') return rawRequest
    return JSON.parse(rawRequest)
}

async function isSecureStoreAvailable(secureStore, warnings) {
    try {
        return await secureStore.isAvailable()
    } catch {
        warnings.push('Secure storage availability check failed.')
        return false
    }
}

async function readSecureSecrets(secureStore, warnings) {
    const secrets = {}
    for (const name of SECRET_NAMES) {
        try {
            const value = normalizeSecretValue(name, await secureStore.getItem(secretStoreKey(name)))
            if (value) secrets[name] = value
        } catch {
            warnings.push(`Secure storage read failed for ${name}.`)
        }
    }
    return secrets
}

async function deleteCleanupFiles(legacyFiles, warnings) {
    for (const filename of CLEANUP_FILES) {
        try {
            await legacyFiles.deleteFile(filename)
        } catch {
            warnings.push(`Legacy cleanup deletion failed for ${filename}.`)
        }
    }
}

async function readLegacySecrets(legacyFiles, warnings) {
    const secrets = {}
    for (const name of SECRET_NAMES) {
        const filename = SECURE_SECRET_FILES[name]
        try {
            const value = normalizeSecretValue(name, await legacyFiles.readFile(filename))
            if (value) secrets[name] = value
        } catch {
            warnings.push(`Legacy secret read failed for ${name}.`)
        }
    }
    return secrets
}

async function migrateLegacySecrets({
    secureStore,
    legacyFiles,
    legacySecrets,
    secureSecrets,
    warnings,
}) {
    for (const name of SECRET_NAMES) {
        const legacyValue = legacySecrets[name]
        if (!legacyValue) continue

        const secureValue = secureSecrets[name]
        if (!secureValue) {
            try {
                await writeAndConfirmSecret(secureStore, name, legacyValue)
                secureSecrets[name] = legacyValue
                await legacyFiles.deleteFile(SECURE_SECRET_FILES[name])
            } catch {
                warnings.push(`Legacy migration failed for ${name}; plaintext copy kept for recovery.`)
            }
            continue
        }

        if (secureValue === legacyValue) {
            try {
                await legacyFiles.deleteFile(SECURE_SECRET_FILES[name])
            } catch {
                warnings.push(`Legacy deletion failed for ${name}.`)
            }
        } else {
            warnings.push(`Legacy ${name} differs from secure storage; plaintext copy kept for recovery.`)
        }
    }
}

async function flushMemorySecrets(secureStore, memoryStore, memorySecrets, secureSecrets, warnings) {
    if (!memoryStore) return

    for (const name of SECRET_NAMES) {
        const value = memorySecrets[name]
        if (!value || secureSecrets[name]) continue
        try {
            await writeAndConfirmSecret(secureStore, name, value)
            secureSecrets[name] = value
            memoryStore.delete(name)
        } catch {
            warnings.push(`Session recovery secret could not be moved to secure storage for ${name}.`)
        }
    }
}

async function writeAndConfirmSecret(secureStore, name, value) {
    await secureStore.setItem(secretStoreKey(name), value)
    const confirmed = normalizeSecretValue(name, await secureStore.getItem(secretStoreKey(name)))
    if (confirmed !== value) throw new Error('Secure storage confirmation failed')
}

async function writeSecretMetadata(metadataStore, mode, secrets, warnings) {
    if (!metadataStore) return

    const fingerprints = {}
    for (const name of SECRET_NAMES) {
        const value = secrets[name]
        if (value) fingerprints[name] = secretFingerprint(value)
    }

    try {
        await metadataStore.setItem(SECRET_METADATA_KEY, JSON.stringify({
            version: SECRET_PAYLOAD_VERSION,
            mode,
            updatedAt: new Date().toISOString(),
            fingerprints,
            warnings,
        }))
    } catch {
        // Metadata is diagnostic only; never block secret migration on it.
    }
}

async function readStoredLoyaltyCardHandles(handleStore, warnings) {
    try {
        return parseLoyaltyCardHandleList(await handleStore.getItem(LOYALTY_CARD_HANDLES_KEY))
    } catch {
        warnings.push('Loyalty-card handle index read failed.')
        return []
    }
}

async function writeStoredLoyaltyCardHandles(handleStore, handles, warnings) {
    try {
        await handleStore.setItem(LOYALTY_CARD_HANDLES_KEY, serializeLoyaltyCardHandles(handles))
    } catch {
        warnings.push('Loyalty-card handle index write failed.')
    }
}

async function readLegacyLoyaltyCardPayloads(legacyStore, warnings) {
    try {
        return parseLoyaltyCardPayloadList(await legacyStore.getItem(LEGACY_LOYALTY_CARDS_KEY))
    } catch {
        warnings.push('Legacy loyalty-card payload read failed.')
        return []
    }
}

async function removeLegacyLoyaltyCardPayload(legacyStore, id, warnings) {
    if (!legacyStore || !id) return

    const payloads = await readLegacyLoyaltyCardPayloads(legacyStore, warnings)
    if (payloads.length === 0) return

    const remaining = payloads.filter((payload) => payload.id !== id)
    try {
        if (remaining.length === 0 && legacyStore.removeItem) {
            await legacyStore.removeItem(LEGACY_LOYALTY_CARDS_KEY)
        } else {
            await legacyStore.setItem(LEGACY_LOYALTY_CARDS_KEY, JSON.stringify(remaining))
        }
    } catch {
        warnings.push('Legacy loyalty-card payload cleanup failed.')
    }
}

async function writeAndConfirmLoyaltyCardPayload(secureStore, handle, payload) {
    const key = loyaltyCardPayloadStoreKey(handle.payloadRef)
    if (!key) throw new Error('Invalid loyalty-card payload ref')

    const encoded = JSON.stringify({
        version: SECRET_PAYLOAD_VERSION,
        id: payload.id,
        name: payload.name,
        type: payload.type,
        data: payload.data,
    })
    await secureStore.setItem(key, encoded)
    const confirmed = normalizeLoyaltyCardPayload(await secureStore.getItem(key))
    if (
        !confirmed ||
        confirmed.id !== payload.id ||
        confirmed.name !== payload.name ||
        confirmed.type !== payload.type ||
        confirmed.data !== payload.data
    ) {
        throw new Error('Loyalty-card secure storage confirmation failed')
    }
}

async function writeLoyaltyCardMetadata(metadataStore, mode, handles, migratedCount, warnings) {
    if (!metadataStore) return

    try {
        await metadataStore.setItem(LOYALTY_CARD_METADATA_KEY, JSON.stringify({
            version: SECRET_PAYLOAD_VERSION,
            mode,
            updatedAt: new Date().toISOString(),
            cardCount: dedupeLoyaltyCardHandles(handles).length,
            migratedCount,
            warnings,
        }))
    } catch {
        // Diagnostic metadata must never block payload migration.
    }
}

function pickBackendSecrets(secrets) {
    const out = {}
    for (const name of BACKEND_SECRET_NAMES) {
        const value = secrets[name]
        if (value) out[name] = value
    }
    return out
}

function normalizeLoyaltyCardPayloadRef(value) {
    const text = normalizeNonEmptyString(value)
    if (!text) return ''
    if (text.startsWith('card.')) {
        const segment = normalizeStorageSegment(text.slice(5))
        return segment ? `card.${segment}` : ''
    }
    return loyaltyCardPayloadRef(text)
}

function normalizeStorageSegment(value) {
    const text = normalizeNonEmptyString(value)
    if (!text) return ''
    return text.replace(SAFE_STORAGE_SEGMENT, '_').slice(0, 160)
}

function normalizeNonEmptyString(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return ''
    const text = String(value).trim()
    return text || ''
}

function parseJsonIfString(value) {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}

function upsertLoyaltyCardHandle(handles, handle) {
    const normalized = normalizeLoyaltyCardHandle(handle)
    if (!normalized) return dedupeLoyaltyCardHandles(handles)

    const out = []
    let replaced = false
    for (const entry of dedupeLoyaltyCardHandles(handles)) {
        if (entry.id === normalized.id) {
            out.push(normalized)
            replaced = true
        } else {
            out.push(entry)
        }
    }
    if (!replaced) out.push(normalized)
    return out
}

function dedupeLoyaltyCardHandles(handles) {
    const out = []
    const seen = new Set()
    for (const handle of handles) {
        const normalized = normalizeLoyaltyCardHandle(handle)
        if (!normalized || seen.has(normalized.id)) continue
        seen.add(normalized.id)
        out.push(normalized)
    }
    return out
}

function fingerprintsFor(secrets) {
    const out = {}
    for (const [name, value] of Object.entries(secrets)) {
        out[name] = secretFingerprint(value)
    }
    return out
}

function normalizeHex(raw, bytes) {
    const hex = String(raw).trim().toLowerCase()
    return HEX.test(hex) && hex.length === bytes * 2 ? hex : null
}

function isBytes(value) {
    return typeof value?.byteLength === 'number' &&
        typeof value !== 'string' &&
        (value instanceof Uint8Array || value.constructor?.name === 'Buffer')
}

function bytesToHex(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    let out = ''
    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, '0')
    }
    return out
}

function bytesToUtf8(value) {
    if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('utf8')
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(value)
    return String.fromCharCode(...new Uint8Array(value))
}
