// A BaseContext is the per-base counterpart of the (single, global) state in
// state.mjs. Multi-base sharing needs N bases replicating CONCURRENTLY, and each
// base's async callbacks (Autobase apply, swarm connections, replication) must
// read/write THAT base's state — module globals can't represent N bases at once.
//
// To keep the proven single-base path zero-risk, the PERSONAL base keeps using
// the state.mjs globals; SHARED single-list bases each get their own
// BaseContext, threaded explicitly into the shared-base lifecycle. The fields
// mirror state.mjs so the shared-base code reads the same way.
//
// `role`: 'personal' (the always-present primary, mirrors state.mjs) or 'shared'
// (one per shared list). `baseId`: a stable id for the base (its discovery-key
// hex), used as the storage namespace and the BaseManager map key.

export function createBaseContext ({ role = 'shared', baseId = null, baseKey = null } = {}) {
    return {
        role,
        baseId,

        // Core P2P instances (per base)
        autobase: null,
        store: null,
        swarm: null,
        discovery: null,

        // Keys / topic (per base)
        baseKey: baseKey ?? null,
        currentTopic: null,
        encryptionKey: null,
        ownerAuthorityKeyPair: null,
        epochKey: null,
        epochEncryptionKeyPair: null,

        membershipState: {
            ownerAuthorityKey: null,
            ownerWriterKey: null,
            highestSequence: 0,
            currentEpoch: 0,
            currentEpochKeyHash: null,
            writers: new Set(),
            writerEpochPublicKeys: new Map(),
            removedWriters: new Map(),
        },
        boardConfigState: { highestSequence: 0, updatedAt: 0, config: null },

        // Blind pairing (per base)
        pairing: null,
        pairingMember: null,
        currentInvite: null,

        // In-memory data (per base)
        currentList: [],
        peerCount: 0,
        knownWriters: new Set(),
        addedStaticPeers: false,

        // State flags (per base)
        isResettingState: false,
        isPendingJoinSuccess: false,
    }
}

// True when the context belongs to the always-present personal/primary base.
export function isPersonalContext (ctx) {
    return !!ctx && ctx.role === 'personal'
}
