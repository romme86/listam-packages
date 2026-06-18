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
