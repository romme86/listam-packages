// Every epoch key this device has held, so the ACTIVE key can be a pointer.
//
// apply used to overwrite a single epoch-key slot the moment it accepted a
// re-key record, and unlink the stored key the moment it accepted a removal of
// this device. Autobase can reorder history and refuse that same record on the
// next pass — but an overwritten key is gone and an unlinked file is gone, so
// the rollback left the device holding a key for a timeline that no longer
// exists (apply-discard-reorder.test.mjs: LEAKED SIDE EFFECT).
//
// Keeping the material turns "adopt" into a pointer move, and a pointer move is
// reversible. Indexed by HASH rather than epoch number: two competing branches
// can each mint an "epoch 2" and only the hash tells them apart, and
// `membershipState.currentEpochKeyHash` is exactly the value that has to be
// matched.
//
// In memory only, and deliberately so. It exists to reverse a reorg within a
// session; across a restart apply does not re-run history, so whatever was
// persisted is already the settled answer.
import { epochKeyHashHex } from './key-epochs.mjs'

export function createEpochKeyring () {
    const byHash = new Map()

    return {
        get size () { return byHash.size },

        // Returns the hash it was filed under, or null if the value is not a
        // usable epoch key.
        remember (key) {
            const hash = epochKeyHashHex(key)
            if (!hash) return null
            if (!byHash.has(hash)) byHash.set(hash, key)
            return hash
        },

        forHash (hash) {
            if (typeof hash !== 'string') return null
            return byHash.get(hash) ?? null
        },

        has (hash) { return typeof hash === 'string' && byHash.has(hash) },

        // Every key held, newest first — the order a decrypt-with-anything
        // fallback should try them in.
        keys () { return [...byHash.values()].reverse() },

        clear () { byHash.clear() },
    }
}

// What the active epoch key SHOULD be, given the membership state reduced from
// the committed view. Pure.
//
// Returns null when nothing should change — which is NOT the same as
// `{ key: null }`, meaning "there should be no active key".
export function resolveActiveEpochKey ({ keyring, membershipState, currentKey, localWriterKey } = {}) {
    // Removed on the committed timeline: this device must not keep an active
    // key. Reversible, because the material stays in the keyring — a reorg that
    // un-removes us re-adopts it below.
    if (localWriterKey && membershipState?.removedWriters?.has?.(localWriterKey)) {
        return currentKey ? { key: null, reason: 'removed' } : null
    }

    const wantHash = membershipState?.currentEpochKeyHash
    if (!wantHash) return null
    if (epochKeyHashHex(currentKey) === wantHash) return null

    const key = keyring?.forHash?.(wantHash) ?? null
    // The committed epoch is one we were never granted. Keep whatever we have:
    // dropping it would only cost us the ability to read history we already
    // replicated, and would not gain us the key we are missing.
    if (!key) return null

    return { key, reason: currentKey ? 'rotated' : 'adopted' }
}
