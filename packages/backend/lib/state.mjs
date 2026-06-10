// Shared mutable state exports
// All modules import from here and use setters to modify state

// Core P2P instances
export let autobase = null
export let store = null
export let swarm = null
export let discovery = null

// RPC instance
export let rpc = null

// Keys and topics
export let baseKey = null
export let currentTopic = null
export let encryptionKey = null       // Buffer — Autobase encryption key
export let ownerAuthorityKeyPair = null
export let epochKey = null            // Buffer — app-level current list epoch key
export let epochEncryptionKeyPair = null
export let membershipState = {
    ownerAuthorityKey: null,
    ownerWriterKey: null,
    highestSequence: 0,
    currentEpoch: 0,
    currentEpochKeyHash: null,
    writers: new Set(),
    writerEpochPublicKeys: new Map(),
    removedWriters: new Map(),
}

// Blind pairing
export let pairing = null             // BlindPairing instance
export let pairingMember = null       // BlindPairing member (host-side handler)
export let currentInvite = null       // { id, invite, publicKey, expires } or null

// In-memory data
export let currentList = []
export let peerCount = 0

// Writer tracking
export const knownWriters = new Set()
export let addedStaticPeers = false

// State flags
export let isResettingState = false
export let isPendingJoinSuccess = false

// Corruption recovery: non-null while the storage root failed to open and the
// backend is waiting for an owner-directed recovery action (M4).
export let pendingRecovery = null

// Transient error tracking
export let transientErrorCount = 0
export let lastTransientErrorTime = 0
export const MAX_TRANSIENT_ERRORS = 10
export const DEFAULT_LIST = [
    { text: 'Tap to mark as done', isDone: false, timeOfCompletion: 0 },
    { text: 'Double tap to add new', isDone: false, timeOfCompletion: 0 },
    { text: 'Slide right slowly to delete', isDone: false, timeOfCompletion: 0 },
]


// Setters for mutable state
export function setAutobase(val) { autobase = val }
export function setStore(val) { store = val }
export function setSwarm(val) { swarm = val }
export function setDiscovery(val) { discovery = val }
export function setRpc(val) { rpc = val }
export function setBaseKey(val) { baseKey = val }
export function setCurrentTopic(val) { currentTopic = val }
export function setEncryptionKey(val) { encryptionKey = val }
export function setOwnerAuthorityKeyPair(val) { ownerAuthorityKeyPair = val }
export function setEpochKey(val) { epochKey = val }
export function setEpochEncryptionKeyPair(val) { epochEncryptionKeyPair = val }
export function setMembershipState(val) { membershipState = val }
export function setPairing(val) { pairing = val }
export function setPairingMember(val) { pairingMember = val }
export function setCurrentInvite(val) { currentInvite = val }
export function setCurrentList(val) { currentList = val }
export function setPeerCount(val) { peerCount = val }
export function setAddedStaticPeers(val) { addedStaticPeers = val }
export function setIsResettingState(val) { isResettingState = val }
export function setIsPendingJoinSuccess(val) { isPendingJoinSuccess = val }
export function setPendingRecovery(val) { pendingRecovery = val }
export function setTransientErrorCount(val) { transientErrorCount = val }
export function setLastTransientErrorTime(val) { lastTransientErrorTime = val }

// Helper to clear known writers
export function clearKnownWriters() { knownWriters.clear() }
