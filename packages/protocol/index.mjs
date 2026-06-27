export const RPC_RESET = 0
export const RPC_MESSAGE = 1
export const RPC_ADD = 2
export const RPC_UPDATE = 3
export const RPC_DELETE = 4
export const RPC_GET_KEY = 5
export const SYNC_LIST = 6
export const RPC_JOIN_KEY = 7
export const RPC_ADD_FROM_BACKEND = 8
export const RPC_UPDATE_FROM_BACKEND = 9
export const RPC_DELETE_FROM_BACKEND = 10
export const RPC_REQUEST_SYNC = 11
export const RPC_CREATE_INVITE = 12
export const RPC_PERSIST_SECRET = 13
export const RPC_REMOVE_MEMBER = 14
export const RPC_GET_MEMBERS = 15
export const RPC_GET_OWNER_RECOVERY_CODE = 16
export const RPC_RECOVER_OWNER = 17
export const RPC_RECOVER_STORAGE = 18
// Owner-control client (Phase 14/15): the frontend drives the worklet's
// hyperdht owner-control client to pair with and command the user's headless
// devices. Replies come back over RPC_MESSAGE as { type: 'owner-control-*' }.
export const RPC_CONTROL_PAIR = 19
export const RPC_CONTROL_COMMAND = 20
export const RPC_CONTROL_LIST = 21
// Board configuration (rigor mode, states, properties, rules,
// automations). The owner-signed record is set by the board creator only;
// RPC_GET replies over RPC_MESSAGE as { type: 'board-config', ... }.
export const RPC_SET_BOARD_CONFIG = 22
export const RPC_GET_BOARD_CONFIG = 23
// Encrypted backup / restore. All three are request/response: the frontend
// passes { password } (and { file } for import) and reads the reply.
// RPC_EXPORT_* reply with { ok, kind, file } where `file` is the encrypted
// envelope text to save. RPC_IMPORT decrypts a saved envelope and branches on
// its `kind`: 'data' merges the content snapshot (last-write-wins), 'seed'
// restores this instance's secret identity.
export const RPC_EXPORT_DATA = 24
export const RPC_EXPORT_SEED = 25
export const RPC_IMPORT = 26
// Leaf BLE provisioning: a central app asks the backend for the data a leaf
// needs to be initialized over Bluetooth — the paired hub's control core key
// and the address(es) the leaf should dial — so the app can write it into the
// leaf's provisioning GATT service (see @listam/provisioning). Reply over
// RPC_MESSAGE as { type: 'leaf-provision-info', controlKey, hubAddr, audioAddr }.
export const RPC_LEAF_PROVISION_INFO = 27
// Move a single item to a different list and/or type WITHIN the same project.
// The backend decomposes the move into ordinary add/delete (or, when the source
// and destination share a listId, a single in-place update) so apply() and old
// peers need no new operation type. Payload:
//   { item, targetListId, targetListType?, fields? }
// `fields` carries form-collected board ticket fields (description, checklist,
// estimatedHours, estimatedComplexity, …) when promoting an item into a board.
// Replies with the mutation result; a rigor-gate failure additionally pushes
// RPC_MESSAGE { type: 'move-rigor-missing', missing } so nothing is deleted.
export const RPC_MOVE = 28
// Automatic backups (device-key + required user password). All request/response.
// LIST replies { ok, backups: [{ file, createdAt }], passwordSet, schedule }
// where `schedule` is { enabled, passwordSet, tiers: [{ reason, label,
// intervalMs, lastAt }] } describing the rolling scheduled backups. RESTORE
// { file, password } decrypts a saved auto-backup and merges it (LWW).
// SET_BACKUP_PASSWORD { current?, next } stores/changes the password (stored
// encrypted under the device key so join-time and scheduled backups run
// unattended).
export const RPC_LIST_BACKUPS = 29
export const RPC_RESTORE_BACKUP = 30
export const RPC_SET_BACKUP_PASSWORD = 31
// Single-list sharing (multi-base). SHARE_LIST { listId } promotes a list into
// its OWN base and returns a BlindPairing invite for it. JOIN_LIST { invite }
// ADDITIVELY joins a shared list's base (unlike RPC_JOIN_KEY, which replaces the
// whole personal base). Both reply request/response.
export const RPC_SHARE_LIST = 32
export const RPC_JOIN_LIST = 33
// Enable/disable rolling scheduled backups (15-min / daily / weekly), which the
// backend writes as fixed-name files overwritten each cadence. { enabled }
// request/response; reply { ok, schedule }. The three cadences themselves are
// fixed; this only toggles the whole schedule on or off.
export const RPC_SET_BACKUP_SCHEDULE = 34
