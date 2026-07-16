import { createMembershipState, reduceMembershipOperation } from './membership.mjs'
import { decryptEpochGrantForWriter, epochKeyHashHex } from './key-epochs.mjs'

// Rebuild membership and recover the newest epoch key granted to this writer.
// Autobase does not replay apply() for already-linearized history on reopen, so
// live grant adoption alone is insufficient after restoring an older key file.
export function recoverEpochKeyFromMembership(records, {
    baseKey,
    localWriterKey,
    epochEncryptionKeyPair,
    currentEpochKey = null,
} = {}) {
    let state = createMembershipState()
    let grantedEpochKey = null

    for (const record of Array.isArray(records) ? records : []) {
        const result = reduceMembershipOperation(record, state, { baseKey })
        state = result.state
        if (!result.ok || !result.effect?.epochGrants) continue

        const candidate = decryptEpochGrantForWriter(
            result.effect.epochGrants,
            localWriterKey,
            epochEncryptionKeyPair,
        )
        if (candidate && epochKeyHashHex(candidate) === result.effect.epochKeyHash) {
            grantedEpochKey = candidate
        }
    }

    const expectedHash = state.currentEpochKeyHash
    if (!expectedHash || epochKeyHashHex(currentEpochKey) === expectedHash) {
        return { state, epochKey: currentEpochKey, recovered: false }
    }
    if (epochKeyHashHex(grantedEpochKey) === expectedHash) {
        return { state, epochKey: grantedEpochKey, recovered: true }
    }
    return { state, epochKey: currentEpochKey, recovered: false }
}
