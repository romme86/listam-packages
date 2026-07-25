import { reduceMembershipOperation } from './membership.mjs'
import { decryptEpochGrantForWriter, epochKeyHashHex } from './key-epochs.mjs'

// Validate a control-channel grant with exactly the same owner signature,
// roster and sealed-recipient rules as the append-only membership path. This
// function has no side effects; callers persist the returned key only on ok.
export function validateDirectEpochGrant(record, {
    membershipState,
    baseKey,
    localWriterKey,
    epochEncryptionKeyPair,
    currentEpochKey = null,
} = {}) {
    const result = reduceMembershipOperation(record, membershipState, { baseKey })
    if (!result.ok) {
        const alreadyAdopted = result.reason === 'replay' &&
            Number(record?.epoch) === Number(membershipState?.currentEpoch) &&
            epochKeyHashHex(currentEpochKey) === record?.epochKeyHash
        return alreadyAdopted
            ? { ok: true, alreadyAdopted: true, state: membershipState, epochKey: currentEpochKey, reason: null }
            : { ok: false, alreadyAdopted: false, state: membershipState, epochKey: null, reason: result.reason }
    }
    if (!result.effect?.epochResynced || !result.effect?.epochGrants) {
        return { ok: false, alreadyAdopted: false, state: membershipState, epochKey: null, reason: 'not-resync' }
    }

    const epochKey = decryptEpochGrantForWriter(
        result.effect.epochGrants,
        localWriterKey,
        epochEncryptionKeyPair,
    )
    if (!epochKey) {
        return { ok: false, alreadyAdopted: false, state: membershipState, epochKey: null, reason: 'not-recipient' }
    }
    if (epochKeyHashHex(epochKey) !== result.effect.epochKeyHash) {
        return { ok: false, alreadyAdopted: false, state: membershipState, epochKey: null, reason: 'wrong-key-hash' }
    }
    return { ok: true, alreadyAdopted: false, state: result.state, epochKey, reason: null }
}
