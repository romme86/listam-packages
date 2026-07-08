# FINAL PLAN — Two-tier multi-owner membership (co-owner + admin)

> **Status: awaiting review (2026-07-01). No code written yet.**
> Locked product decisions: (1) two tiers — full co-owner + limited admin; (2) promoted device mints its OWN authority key (secret never leaves it); (3) any owner revokes, root + last-owner protected; (4) **board-config stays ROOT-ONLY for v1** (see §9 R1).
> Derived from a 4-designer + 3-reviewer red-team workflow. Review this doc, then tell me what to change or to proceed with Phase A.

## 1. Summary

**What ships.** A per-base, two-tier authority model on top of the existing single-owner Autobase membership log:
- **Co-owner** — can add/remove writers, mint invites, AND designate/revoke owners and admins.
- **Admin** — can add/remove writers and mint invites, but CANNOT create or revoke owners/admins.
- **Root** — the bootstrap creator; a permanent co-owner that can never be revoked or removed.
- Each owner/admin holds its **own** owner-authority keypair, minted on its own device (secret never leaves), with its own recovery code. A promoted device advertises a **signed** candidate public key over a synced channel; an existing owner references that exact pubkey when signing the promotion.

**Safety story (why no fork, no lockout, no unauthorized admin).**

- **No fork.** The membership record format stays `version:1` and the four new actions null-strip to byte-identical legacy signing payloads, so old signatures verify unchanged. Old peers reject the four new actions as `malformed` (never `view.append`), which is inert *in-memory* — but because a rejected role record is never persisted, an old peer's *checkpoint* would diverge from a new peer's. Therefore **every multi-owner-specific write (all four role actions AND any non-root-signed add/remove-writer AND any per-signer sequence that would collide with the legacy scalar) is gated behind a signed, version-asserting capability beacon (`__caps__`) that must show the whole current writer set on compatible code.** Until the gate is green, every signer serializes through the legacy single-scalar sequence path exactly as today, so a mixed mesh is byte-identical to the current shipping behavior. The gate is fail-safe against downgrade (it only opens when *no* current writer advertises an incompatible/absent version) and is defended against forged beacons (beacons are writer-signed and verified).
- **No lockout.** Root and the last remaining owner can never be revoked (evaluated over linearized state). Promotion is **gated on the subject holding the current epoch key** and **re-grants the current epoch to the subject in the same record**, so a promoted co-owner can always execute a member-removal re-key. Promotion is not considered complete until the new owner has confirmed storage of its recovery code, and the roster surfaces **effective administrability** (how many owners have a live, recoverable secret). A dead/un-grantable pinned root no longer wedges re-key: re-key excludes un-grantable pinned writers from the grant-completeness check. Role and writer Maps are reconciled (removing a writer cascades its role entries), so no phantom owner inflates the last-owner floor.
- **No unauthorized admin.** Authorization is decided at apply time over linearized state: admins cannot sign any role action; only owners can grant/revoke. A **persistent `revokedAuthorities` tombstone set** prevents a revoked authority pubkey from ever being re-added or re-recovered, and revoked signers' sequence counters are **tombstoned (never deleted)** so no replayed old record from a revoked signer can be accepted on any peer regardless of linearization order. Candidate pubkeys are writer-signed (can't advertise under someone else's writerKey), the promote dialog forces out-of-band confirmation of the **writerKey + authorityKey fingerprint** (defeating peer-label spoofing and candidate-pool poisoning), and the grant embeds the exact approved `subjectAuthorityKey`. Revoking an admin triggers an epoch rotation to invalidate any epoch key handed out by that admin's outstanding invites.

**Residual risks that are product-accepted, not code-defended, are listed in §9.**

---

## 2. State + wire format

**File: `listam-packages/packages/backend/lib/membership.mjs`**

### New constants (after line 8)
```js
export const ADD_OWNER_ACTION    = 'add-owner'
export const ADD_ADMIN_ACTION    = 'add-admin'
export const REVOKE_OWNER_ACTION = 'revoke-owner'
export const REVOKE_ADMIN_ACTION = 'revoke-admin'
export const TIER_ROOT  = 'root'
export const TIER_OWNER = 'owner'
export const TIER_ADMIN = 'admin'
```

### State shape — extend `createMembershipState()` (`:18`)
```js
owners:  new Map(),  // authorityPubKey -> { writerKey, tier:'root'|'owner', addedBy, addedAt }
admins:  new Map(),  // authorityPubKey -> { writerKey, addedBy, addedAt }
sequences: new Map(),         // signerAuthorityPubKey -> highest accepted sequence (per-signer)
revokedAuthorities: new Map(),// authorityPubKey -> { revokedBy, revokedAt, lastSequence } TOMBSTONE, never deleted
```
Retained back-compat fields: `ownerAuthorityKey` (= ROOT authority, immutable), `ownerWriterKey` (root's writer key), `highestSequence` (legacy global scalar mirror), `writers`, `removedWriters`, `writerEpochPublicKeys`, `currentEpoch`.

**Decisions folded from the red team:**
- **D1** (keying): authorization set is keyed by **authority pubkey**, each entry stores its bound `writerKey`. (Facet 1 index + Facets 2/3 binding.)
- **`revokedAuthorities` is a tombstone Map, entries are NEVER deleted** — closes the revoked-owner resurrection, revoked-signer sequence-reset replay fork, and stale-state re-recovery findings (RT-2.1, RT-1.4, RT-2.8, RT-1.10). We store `lastSequence` so the replay floor for a revoked signer is preserved.

`cloneMembershipState()` (`:31`) deep-copies all Maps:
```js
owners: new Map(state?.owners||[]),
admins: new Map(state?.admins||[]),
sequences: new Map(state?.sequences||[]),
revokedAuthorities: new Map(state?.revokedAuthorities||[]),
```
Cloning is load-bearing: `apply()` reduces incrementally over a clone.

### Wire/record format (envelope reused, `MEMBERSHIP_RECORD_VERSION` stays **1**)

Rationale for keeping version 1: bumping it makes `normalizeMembershipBody` reject *all* new records on old peers at `:356`, breaking replication interop. Extensions are additive actions + optional null-stripped fields.

**Role grant record (add-owner / add-admin):**
```js
{ type:'membership', version:1, action, baseKey,
  ownerAuthorityKey:<signerPub>,        // the SIGNING owner's pubkey
  subjectAuthorityKey:<targetPub>,      // candidate authority pubkey being granted
  subjectWriterKey:<promotedWriter>,    // the promoted device's writer key
  subjectEpochGrant:<encGrant>,         // current-epoch key encrypted to subject's epoch pubkey (see §3/§4)
  candidateNonce:<n>,                   // echoes the candidate item's version/nonce the owner approved
  sequence:<per-signer next>, createdAt, signature }
```
**Role revoke record (revoke-owner / revoke-admin):**
```js
{ type:'membership', version:1, action, baseKey,
  ownerAuthorityKey:<signerPub>, subjectAuthorityKey:<targetPub>,
  sequence:<per-signer next>, createdAt, signature }
```
All epoch-rotation fields (`previousEpoch`, `newEpoch`, `epochGrants`, `newEpochKeyHash`) are **forbidden** on all four role records.

`membershipSigningPayload` (`:396`) — insert `subjectAuthorityKey`, `subjectWriterKey`, `subjectEpochGrant`, `candidateNonce` into the payload object (after `writerKey`). The existing null-strip loop (`:413-415`) deletes null keys, so **legacy bootstrap/add-writer/remove-writer records produce byte-identical signing payloads** (all four new fields absent → stripped) — old signatures still verify. This is the crux of wire back-compat and is locked by a golden-vector test (§7 test 1).

---

## 3. Reducer rules (`reduceMembershipOperation` `:210`, `normalizeMembershipBody` `:336`)

### Authorization + sequence helpers
```js
export function isRevoked(state, pub){ return !!pub && state?.revokedAuthorities?.has(pub) }
export function isOwnerAuthority(state, pub){
  if (!pub || isRevoked(state, pub)) return false
  return state?.owners?.has(pub)
      || (state?.owners?.size===0 && state?.ownerAuthorityKey===pub) // migration-only fallback (see note)
}
export function isAdminAuthority(state, pub){ return !!pub && !isRevoked(state,pub) && state?.admins?.has(pub) }
export function canAdminMembership(state, pub){ return isOwnerAuthority(state,pub) || isAdminAuthority(state,pub) }
export function canGrantRoles(state, pub){ return isOwnerAuthority(state,pub) } // owner-only

function nextSeqFor(state, signerPub){
  const fromMap    = Number(state?.sequences?.get(signerPub)) || 0
  const fromTomb   = Number(state?.revokedAuthorities?.get(signerPub)?.lastSequence) || 0
  const legacy     = (signerPub === state?.ownerAuthorityKey) ? (Number(state?.highestSequence)||0) : 0
  return Math.max(fromMap, fromTomb, legacy)  // tombstone keeps a revoked signer's floor monotonic
}
```
`nextMembershipSequence(state, signerPub)` (`:71`) returns `nextSeqFor(state, signerPub) + 1`. Callers pass the signer explicitly: `network.mjs:354`, `shared-base.mjs:382,574`, `rekey.mjs:110`.

**Migration-fallback safety (RT-2.6):** the `owners.size===0` clause authorizes ONLY legacy `add-writer`/`remove-writer` during the migration re-fold window — it is *never* consulted by the four role branches (they call `isOwnerAuthority` which, given a fully-folded log, always has `owners.size>=1` because bootstrap folds first). A test asserts a second bootstrap record is always rejected `owner-exists` regardless of replay start index, and that the fallback clause cannot authorize an add-owner.

### `normalizeMembershipBody` — HARD field gates (RT-1.8)
Extend the action whitelist (`:338-342`) with the four actions. Parse `subjectAuthorityKey`/`subjectWriterKey` via `normalizeHex(..., OWNER_AUTHORITY_PUBLIC_BYTES / WRITER_KEY_BYTES)`. **Field gates must `return null` (reject), not merely document:**
- `bootstrap`/`add-writer`/`remove-writer`: require `writerKey`; **`return null` if any of `subjectAuthorityKey`/`subjectWriterKey`/`subjectEpochGrant`/`candidateNonce` is present.** (This makes a future accidental leak of subject fields onto a legacy action reject uniformly on ALL peers — no accepted-only-on-new fork.)
- `add-owner`/`add-admin`: require `subjectAuthorityKey` AND `subjectWriterKey` AND `subjectEpochGrant`; forbid `writerKey` and all epoch-rotation fields.
- `revoke-owner`/`revoke-admin`: require `subjectAuthorityKey`; forbid `writerKey`/`subjectWriterKey`/`subjectEpochGrant`/`candidateNonce`/epoch fields.

### Per-action reducer branches

**`OWNER_BOOTSTRAP_ACTION` (`:230`)** — guard `if (current.ownerAuthorityKey || current.owners.size) return rejected('owner-exists', current)`. On accept, in addition to existing sets: `next.owners.set(body.ownerAuthorityKey,{writerKey:body.writerKey,tier:'root',addedBy:null,addedAt:body.createdAt})`; `next.sequences.set(body.ownerAuthorityKey, body.sequence)`. Keep `ownerAuthorityKey`/`ownerWriterKey`/`highestSequence` mirror.

**`ADD_WRITER_ACTION` (`:245`) / `REMOVE_WRITER_ACTION` (`:259`)** —
- Auth: `if (!canAdminMembership(current, body.ownerAuthorityKey)) return rejected('not-authorized', current)`.
- **Mesh gate for non-root signers (RT-1.1, closes the per-signer/scalar fork):** `if (body.ownerAuthorityKey !== current.ownerAuthorityKey && !current._meshMultiOwnerActivated) return rejected('multi-owner-not-active', current)`. `_meshMultiOwnerActivated` is a linearized high-water flag set the first time a role grant is accepted (see below) — it is derived from persisted records, not from the live beacon, so it is consistent across peers. Until it flips, **only root-signed** add/remove-writer is legal, and every signer allocates against the legacy scalar path.
- Replay: `if (body.sequence <= nextSeqFor(current, body.ownerAuthorityKey)) return rejected('replay', current)`.
- Existing `removedWriters`, last-writer, epoch-rotation, `cannot-remove-owner` guards (`:263-273`) unchanged.
- **REMOVE_WRITER cascade (RT-2.5, RT-1.10):** if `body.writerKey` is bound to any `owners`/`admins` entry, either reject `revoke-role-first`, OR delete that role entry AND re-apply the last-owner/root check to the implied revoke. **Chosen: reject `revoke-role-first`** — eviction of a role-holder requires an explicit prior revoke, keeping the two Maps reconciled and making the last-owner floor honest.
- On accept: `next.sequences.set(body.ownerAuthorityKey, body.sequence)`; if signer is root, also advance `next.highestSequence`.

**`ADD_OWNER_ACTION` / `ADD_ADMIN_ACTION`** —
- `if (!canGrantRoles(current, body.ownerAuthorityKey)) return rejected('not-owner', current)` (admins cannot grant — RT-1.6).
- `if (isRevoked(current, body.subjectAuthorityKey)) return rejected('authority-tombstoned', current)` (RT-2.1: a tombstoned pubkey can never be re-granted).
- `if (body.sequence <= nextSeqFor(current, body.ownerAuthorityKey)) return rejected('replay', current)`.
- **Subject-is-current-writer is MANDATORY (RT-1.10):** `if (!current.writers.has(body.subjectWriterKey) || current.removedWriters.has(body.subjectWriterKey)) return rejected('not-a-writer', current)`. No phantom owners.
- **Current-epoch key possession is enforced (RT-3.1):** the record MUST carry `subjectEpochGrant` for the subject at `current.currentEpoch`; the reducer records it into `next.writerEpochPublicKeys`/epoch-grant state for the subject so the promoted writer is guaranteed to hold the current epoch key. If `subjectEpochGrant`'s epoch != `current.currentEpoch`, reject `stale-epoch-grant`.
- Cross-tier: if `subjectAuthorityKey` is in the *other* role set → `rejected('must-revoke-first')`; if already in the *target* set → idempotent no-op.
- On accept: add `{writerKey:body.subjectWriterKey, tier, addedBy:body.ownerAuthorityKey, addedAt:body.createdAt}` to `owners`/`admins`; `next.sequences.set(signer, seq)`; **set `next._meshMultiOwnerActivated = true`** (first grant flips the high-water — no un-upgraded writer can be present because the beacon gated the write, and from here new peers require the beacon for post-activation add-writer, RT-3.6). Effect `{roleGranted:{role, subjectAuthorityKey, subjectWriterKey}}`. No `addWriterKey` in the effect (subject already a writer).

**`REVOKE_OWNER_ACTION` / `REVOKE_ADMIN_ACTION`** —
- `if (!canGrantRoles(current, body.ownerAuthorityKey)) return rejected('not-owner', current)`.
- Replay guard as above.
- `if (current.owners.get(body.subjectAuthorityKey)?.tier==='root' || body.subjectAuthorityKey===current.ownerAuthorityKey) return rejected('cannot-revoke-root', current)` (product rule 3).
- revoke-owner only: `if (current.owners.size <= 1) return rejected('last-owner', current)`. Evaluated over linearized state so concurrent revokes converge (RT #11/§7).
- `if (!current.owners.has(sub) [/.admins.has(sub)]) return rejected('unknown-role', current)`.
- On accept: delete from the set; **write a tombstone** `next.revokedAuthorities.set(subjectAuthorityKey, {revokedBy:signer, revokedAt:body.createdAt, lastSequence: current.sequences.get(subjectAuthorityKey)||0})` and **delete the live `sequences` entry** (the floor now lives in the tombstone via `nextSeqFor`, so replayed old records from the revoked signer fail on ALL peers — RT-2.8). Set signer sequence. Effect `{roleRevoked:{role, subjectAuthorityKey, wasAdmin}}`. **No epoch rotation for revoke-owner; revoke-admin triggers an epoch rotation** (see §4, RT-2.11) to invalidate any epoch key an outstanding admin invite handed out.

Admins may sign add/remove-writer (`canAdminMembership`) but NONE of the four role actions (`canGrantRoles` = owner-only in each branch).

---

## 4. Promotion key-exchange (candidate channel + identity binding + confirm flow)

**Product decision #2: the promoted device generates its OWN owner-authority keypair; the secret never leaves it.** All authority keys are **per-base** (RT-1.3).

### Per-base authority storage (RT-1.3, RT-3.4)
The single `ownerAuthorityKey` secrets slot is replaced by a per-base map: `secrets` stores `authorityByBase: Map<baseKey, {publicKey, secretKey}>`. `publishOwnerCandidate` mints a **base-scoped** key and never reuses the root/personal key of another base. Recovery reveal and the generalized recover path are per-`(baseKey, authorityPub)`. Recovery **refuses to overwrite** an existing distinct local authority for that base without explicit confirmation.

### 1. Publish (promoted device) — `RPC_PUBLISH_OWNER_CANDIDATE`
Backend mints a base-scoped `createOwnerAuthorityKeyPair()` if none exists for this base, persists the secret in `authorityByBase[baseKey]`, then writes a candidate item over the synced channel carrying only the **public** key + a writer-signature + a monotonic `nonce`.

### 2. Candidate channel
Predicate + constants live in `domain/labels.mjs` (crypto-free); build/reduce (needs `hypercore-crypto`) live in a **new backend file `lib/owner-candidates.mjs`** (respects the domain-package no-crypto layering, D3):
```js
// domain/labels.mjs
export const OWNER_CANDIDATE_LIST_ID='__ownercandidates__'
export const OWNER_CANDIDATE_LIST_TYPE='ownercandidate'
export function isOwnerCandidateItem(item){ return !!item && typeof item==='object' && item.listType===OWNER_CANDIDATE_LIST_TYPE }
// backend/lib/owner-candidates.mjs
export function buildOwnerCandidateItem({writerKey,authorityPublicKey,writerSignature,nonce,updatedAt}) {…}
export function signOwnerCandidate(writerKeyPair,{writerKey,authorityPublicKey,baseKey,nonce}) {…}
export function reduceOwnerCandidates(items,{baseKey}) {…} // Map<writerKey,{authorityKey,nonce}>, LWW by updatedAt, DROP entries whose sig fails verify
```
Fold `isOwnerCandidateItem` into `isLabelItem` (`:64-66`) so every projection/nav filter drops it (covers `backend.mjs:1151` and the nav library, which `isInternalChannelItem` does NOT — D3).

### 3. Identity binding (RT-1.5, RT-2.2)
`candSig` is produced with the device's **autobase writer keypair** (`autobase.local.keyPair`) over `{writerKey, authorityPublicKey, baseKey, nonce}`. `reduceOwnerCandidates` verifies with `hypercore-crypto.verify` against `writerKey` and drops unverifiable entries. Only the holder of a writer's secret can bind an authority pubkey to that writerKey.

**Correction of Facet 2's claim (verified):** `__sharedjoinreq__` is NOT writer-signed (`buildSharedJoinReqItem`, shared-creds.mjs:79 carries no signature) — this design *adds* a binding shared-creds never had.

### 4. Promote (existing owner device) — `RPC_PROMOTE_MEMBER {writerKey, tier}`
- Gate `canGrantRoles` (owner-only) + **append-time mesh-gate check** (refuse if `meshSupportsMultiOwner` is false).
- `reduceOwnerCandidates(allItems)` → look up `writerKey → {candidateAuthorityPub, nonce}`; if absent reply `{type:'role-grant-failed', reason:'no-candidate-key'}`.
- **Out-of-band confirm (RT-1.5, RT-2.7):** the promote UI displays the **writerKey fingerprint AND the candidate authorityKey fingerprint** (safety-number style) and requires explicit per-hash confirmation. The UI **never auto-selects from the candidate channel**; selection is by verified writerKey, not by spoofable peer label.
- **Current-epoch grant:** build `subjectEpochGrant` by encrypting the current epoch key to the candidate's writer-epoch pubkey (via existing `createEpochGrants`/`key-epochs.mjs`), so promotion guarantees current-epoch possession (RT-3.1).
- Build `createAddOwnerRecord`/`createAddAdminRecord({ownerAuthorityKeyPair, subjectAuthorityKey:candidateAuthorityPub, subjectWriterKey:writerKey, subjectEpochGrant, candidateNonce:nonce, sequence:nextMembershipSequence(state, selfPub), baseKey})`.
- **Serialize through `enqueueWrite` (RT-1.2 TOCTOU):** read-allocate-append-update runs atomically per signer via the existing serialization chain (rekey.mjs:130 mechanism); after `autobase.update()`, re-read state and confirm the grant to the operator only if it linearized.
- `broadcastMembershipRoster`.

### 5. Two-phase completion ack (RT-2.7, RT-3.2)
The promotion is not surfaced as **complete** until the promoted device posts an **ack** proving it still holds `subjectAuthorityKey`'s secret AND has **confirmed storage of its recovery code**. The candidate `nonce` is echoed in the grant; if the promoted device rotated its candidate since (LWW), the stale in-flight promotion is invalidated and the UI re-prompts. Until ack, the roster shows the member as `promotion-pending`.

### 6. Per-authority recovery (RT-1.4, RT-2.1, RT-3.4)
Reveal already works per-local-keypair (`sendOwnerRecoveryCodeToFrontend`, network.mjs:1080) — now per-`(base,authority)`. **Fixes:** `recoverOwnerAuthority` (network.mjs:1099) generalizes its expected-key set to iterate `[...owners.keys(), ...admins.keys(), ownerAuthorityKey]` for the target base, **AND rejects any pubkey in `revokedAuthorities`** (tombstone check), AND **refuses to silently overwrite** an existing distinct local authority for that base. `owner-recovery.mjs` core is unchanged; only the caller's expected-set widens + tombstone/overwrite guards.

---

## 5. RPCs + per-app UI + i18n

### Protocol (`listam-packages/packages/protocol/index.mjs`, append after `:77`; mirror in `index.d.ts`)
```
RPC_PROMOTE_MEMBER              = 35   // { writerKey, tier:'owner'|'admin', confirmFingerprint }
RPC_REVOKE_ROLE                 = 36   // { writerKey }
RPC_PUBLISH_OWNER_CANDIDATE     = 37   // {}
RPC_GET_AUTHORITY_RECOVERY_CODE = 38   // {}
RPC_ACK_PROMOTION               = 39   // { subjectAuthorityKey, recoveryCodeStored:true }
```
`RPC_CREATE_INVITE=12` / `RPC_REMOVE_MEMBER=14` gates widen from owner-only to `canCreateMembershipInvite` = owner∪admin. **No RPC ever transmits an authority secret.**

### Backend dispatch (`backend.mjs` ~`:418-447`)
Wire the new cases to `network.mjs`: `promoteMember`, `revokeRole`, `publishOwnerCandidate`, `sendAuthorityRecoveryCodeToFrontend`, `ackPromotion`. In `apply()` (`:1573`) extend the roster-rebroadcast guard so `roleGranted`/`roleRevoked` also call `broadcastMembershipRoster`. **revoke-admin's `roleRevoked{wasAdmin:true}` effect triggers `performMemberRemovalRekey`-style epoch rotation** (RT-2.11). Role effects carry no `addWriterKey`/`removeWriterKey`, so `host.addWriter` at `:1538` is untouched. **Keep board-config authority (`:1512,:1585`) pinned to root** (§9 residual).

### Roster (`buildMembershipRoster` `:79`) — backward-compatible superset
Keep `currentEpoch`, `ownerWriterKey`, `canAdminister`, `writers[].{writerKey,isOwner,isSelf}`. Add per-member `role:'root-owner'|'co-owner'|'admin'|'member'`, `authorityKey`, `promotionPending`; top-level `capabilities:{canManageWriters, canManageOwners}`, `selfRole`, `meshSupportsMultiOwner`, and **`administrability:{ownersWithRecoverableSecret, warnLowRedundancy}`** (RT-3.2). Invariants preserved: `isOwner===(role∈{root-owner,co-owner})`, `canAdminister===capabilities.canManageWriters`. `canManageWriters`=owner∪admin; `canManageOwners`=owner-only. **`selfRole`/`canManageOwners` are derived from the linearized `owners`/`admins` Map, NOT from merely holding a local keypair** (RT-1.10: a revoked-then-recovered device must not show enabled controls). `broadcastMembershipRoster` (`:1062`) passes `localAuthorityKey`, computes `meshSupportsMultiOwner` from the signed beacon reducer, and computes `administrability`.

### Mobile (`listam-mobile`)
- `app/store/devicesSlice.ts:4-15` — extend `MembershipMember` (`role`,`authorityKey`,`promotionPending`) + `MembershipRoster` (`capabilities`,`selfRole`,`meshSupportsMultiOwner`,`administrability`); carry through `rosterReceived` (`:39`) + `selectMembershipRoster` (`:76`); map legacy `canAdminister→capabilities.canManageWriters`.
- `app/components/MembersDialog.tsx:73-169` — role badges; per-row `Make co-owner`/`Make admin` (when `canManageOwners && role==='member'`), `Revoke` (when `canManageOwners && role∈{co-owner,admin} && role!=='root-owner'`), all disabled unless `meshSupportsMultiOwner`. **Promote dialog shows writerKey + authorityKey fingerprints and requires explicit confirm.** "Make this device promotable" fires `RPC_PUBLISH_OWNER_CANDIDATE`. **New-owner flow blocks completion until recovery code confirmed stored (`RPC_ACK_PROMOTION`).** Low-redundancy roster warning banner.
- `app/index.tsx:1223-1250` — handlers `onPromote`, `onRevokeRole`, `onPublishOwnerCandidate`, `onRevealAuthorityRecoveryCode`, `onAckPromotion`.
- `app/hooks/_useWorklet.ts:267-299` — message cases `role-grant-failed`, `role-revoked`/`revoke-failed`, `authority-recovery-code`, `promotion-pending`, `promotion-complete`.

### Desktop (`listam-desktop`; `src/ui.mjs` is BINARY to BSD grep — use `grep -a`)
- `src/store.mjs:262-300` — `membership-roster` passes `payload.roster` verbatim; add `authorityRecoveryCode` state + handling for `authority-recovery-code`/`role-grant-failed`/`role-revoked`/`promotion-pending`; init `roster:null` at `:8`.
- `src/ui.mjs:4477-4499` (renderMemberRows) — role chips + Make co-owner/Make admin/Revoke gated on `canManageOwners` + root/last-owner + `meshSupportsMultiOwner`; **fingerprint-confirm promote dialog**; per-authority recovery reveal (net-new); low-redundancy banner. `src/ui.mjs:1414-1428` — actions `promoteMember`/`revokeRole`/`publishOwnerCandidate`/`revealAuthorityRecoveryCode`/`ackPromotion`.
- `mock-backend.mjs` emits the new roster shape + candidate/recovery/promotion messages so `?mock=1` renders. Candidate channel rides the existing `@listam/domain/labels` importmap entry (`index.html:20`).

### Headless (`listam-headless`)
`headless.mjs` JSON-line ops `promote-member {writerKey,tier}`, `revoke-role {writerKey}` → same `network.mjs` functions; a promoted headless peer auto-publishes its candidate and auto-acks with a recovery-code file written to `--storage`. `src/service.mjs:477-487` — add ops + surface `role`/`capabilities`/`administrability` in `snapshot()`. Owner-control remote surface exposes promote/revoke ONLY to owner-capability control devices; **publish-candidate + recovery-reveal stay OPERATOR-only** (a secret must never be minted/revealed remotely).

### i18n (`listam-packages/packages/i18n/catalogs/{en,es,de,fr,it,pt}.mjs` + `index.d.ts`; mobile `check:i18n` fails on any missing key in any of 6)
Add: `members.role.{rootOwner,coOwner,admin}`, `members.action.{makeOwner,makeAdmin,revoke,becomePromotable,meshNotReady}`, `members.confirmPromote.{title,fingerprint,confirm}`, `members.confirmRevoke.*`, `members.recovery.{authorityTitle,showAuthority,confirmStored}`, `members.warn.lowRedundancy`, `members.promotionPending`, `backend.rolePromote.*`, `backend.roleRevoke.*`.

---

## 6. Migration + mesh-gating

### Migration (no on-disk rewrite)
`reduceMembershipLog` (`:309`) replays persisted records on every restart. The bootstrap branch deterministically seeds `owners={root}` + `sequences={root:…}` on every peer, so a legacy base (bootstrap + add-writer records) reduces to identical authority on old and new code — zero data migration, no epoch bump. Legacy records verify byte-identically (null-strip). The `owners.size===0` fallback covers the not-yet-reduced clone edge but never authorizes a role action (§3).

### The fork vectors and how each is closed
1. **Non-root/co-owner/admin-signed add-writer** — old peers reject `wrong-owner` at `:247`, new peers `host.addWriter` → divergence. **Closed:** reducer refuses any non-root-signed add/remove-writer until `_meshMultiOwnerActivated` (which only flips behind the beacon gate).
2. **Per-signer sequence colliding with the legacy scalar** (RT-1.1) — two owners each emit `sequence=5`; old peers reject the second as `replay` against the global scalar. **Closed:** while `meshSupportsMultiOwner` is false, ALL signers allocate `sequence = nextSeqFor(root/global) + 1` and serialize through one path exactly as today; per-signer counters only diverge from the scalar AFTER activation, i.e. after every writer is provably on new code.
3. **Role records dropped-not-persisted on old peers → checkpoint divergence that survives upgrade** (RT-2.9) — old peers `rejected('malformed')` and skip `view.append`, so the record never enters their checkpoint. **Closed:** the beacon gates ALL role writes (not just add-writer), so no role record is ever minted while any writer runs old code; by the time role records exist, every writer persists them.
4. **Forged beacon opens the gate** (RT-1.7) — **Closed:** the `__caps__` beacon is **writer-signed and version-asserting**; `reduceCaps` verifies the signature against `writerKey` and drops forgeries, and only counts a beacon whose `id===writerKey`.
5. **Transient/new/offline writer wedging the gate closed, or a rogue admin jamming it** (RT-1.6, RT-2.10) — **Closed by inverting the predicate to fail-safe-against-downgrade:** the gate is `no current writer advertises an INCOMPATIBLE (older) version`, with a bounded grace for a writer seen but not-yet-beaconed. A brand-new or briefly-offline *upgraded* writer does not flip the gate closed; only a writer positively on old code (or a permanently-silent writer past the grace window, which root removes via a legacy-safe remove-writer) does.

### Mesh-gate = signed, versioned capability beacon (`__caps__`, new `backend/lib/caps.mjs`)
- `CAP_LIST_ID='__caps__'`, `CAP_LIST_TYPE='cap'`, one item per device, `id=writerKey`, value `{version:MULTI_OWNER_CAP_VERSION}` + `sig` over `{writerKey, version, baseKey}` using `autobase.local.keyPair`. Brand-new listType → old peers bucket it unrendered (labels.mjs guarantee). Add `isCapItem` to `isLabelItem`.
- On becoming writable, each upgraded device writes its signed beacon.
- `reduceCaps(items,{baseKey})` verifies each sig against its `writerKey`, drops forgeries/mismatched-id.
- `meshSupportsMultiOwner(state, caps) =` **no writer in `state.writers` advertises a version below `MULTI_OWNER_CAP_VERSION`**, AND every writer either advertises a compatible version or is within the not-yet-beaconed grace window (writers past grace with no beacon must be root-removed before the gate opens). Fail-safe: absent/old beacon never opens the gate.
- **Enforced in TWO places:** the promote/revoke/non-root-add-writer UI hides/disables, AND `promoteMember`/`revokeRole`/non-root `createAddWriterMembershipRecord` refuse at append time. **The reducer additionally refuses non-root add/remove-writer and all role actions pre-activation via `_meshMultiOwnerActivated`** — this is the consensus-enforced belt (RT-2.5): even a buggy/bypassing client cannot mint a pre-activation role write that new peers accept, because `_meshMultiOwnerActivated` is a linearized property and role/non-root writes are refused until a grant has been accepted, which itself requires the beacon-gated first grant. (Honest note: the *very first* grant relies on the client-side append gate being correct, since `_meshMultiOwnerActivated` is false at that instant — see §9 residual.)

### Staged rollout order
- **Stage 1 (read side, ship EVERYWHERE first):** extended reducer (accepts 4 actions, owner/admin/sequences/revoked Maps, per-signer sequence, cascade + tombstone), signed `__caps__` beacon writer/reader, `__ownercandidates__` channel, richer roster. No device promotes or emits a non-root add-writer yet → mesh byte-identical to today, cannot fork. **Roll out headless first** (npm publish `@listam/*` so headless dual-reads — the CLAUDE.md dependency model means version bumps don't auto-propagate; headless must be republished/reinstalled before any base it participates in can open the gate). Leaf is a blind mirror, never a writer, never participates. Shared single-list bases (`shared-base.mjs:274`) reduce through the same reducer/checkpoint and get a per-base beacon.
- **Stage 2 (write side, gated):** per base, enable Make-co-owner/Make-admin + admin-signed/non-root add-writer only once `meshSupportsMultiOwner` is true. A permanently-offline un-upgraded writer is removed by a root-signed remove-writer (always legacy-safe) before the gate opens.

Invite-minting authority (`network.mjs:264,342`; `shared-base.mjs:322,372,566`; `rekey.mjs:70`) widens to owner∪admin via `canCreateMembershipInvite`. `rekey.mjs` member-removal stays owner∪admin (admins may remove writers, product #1). Board-config authority stays root-pinned (§9).

---

## 7. Test matrix

New `listam-packages/packages/backend/membership.test.mjs` + `owner-candidates.test.mjs` + `caps.test.mjs` (node:test, `board-config.test.mjs` structure). Integration in `backend-node.test.mjs` (private DHT).

**Golden / determinism**
1. Golden-vector: exact signature bytes of a legacy add-writer record locked; a future field addition cannot change legacy verification.
2. `reduceMembershipLog` over legacy log → `owners={root}`, `admins={}`, identical writer set, `sequences={root:…}`.

**Back-compat / fork**
3. Co-owner-signed add-writer: OLD reducer REJECTS `wrong-owner`, NEW ACCEPTS (documents the vector) — and NEW reducer refuses it pre-activation (`multi-owner-not-active`).
4. add-owner on OLD reducer → `rejected('malformed')`, no state change, no throw.
5. Legacy add-writer with an unexpected extra key → new signing projection ignores it, old+new agree.
6. **(RT-1.8)** add-writer/bootstrap/remove-writer carrying any subject field → `normalizeMembershipBody` returns null on ALL peers (uniform reject, no fork).
7. **(RT-1.1)** Two owners both emit `sequence=5` while gate closed → both forced onto the scalar path, second rejected `replay` on old AND new; after activation, distinct-signer `sequence=5` both accepted.
8. **(RT-2.9)** A peer applies a role record on OLD code, then upgrades → converges with a peer that applied it on new code (passes ONLY because role writes are beacon-gated; a variant with an un-gated role write asserts the fork, proving the gate is load-bearing).

**Authorization / tiers**
9. Admin-signed add-owner rejected everywhere (`not-owner`).
10. Admin-signed add-writer ACCEPTED (post-activation); admin-signed revoke-admin rejected.
11. Root promotes co-owner → co-owner signs add-writer and add-admin.
12. **(RT-1.10)** add-owner targeting a non-writer / removed writer → `not-a-writer`; no phantom owner.

**Root / last-owner protection**
13. revoke of root rejected (`cannot-revoke-root`).
14. revoke-owner at `owners.size===1` rejected (`last-owner`).
15. Two concurrent revoke-owner of the 2nd-to-last owner → deterministic single success + `last-owner` rejection on all peers regardless of order.
16. **(RT-3.3)** Two owners X,Y mutually revoke (`revoke(Y)` and `revoke(X)`) starting from {R,X,Y}: assert the aggregate result is documented/tested (collapses to {R}); if a redundancy floor is added, assert compare-and-swap rejection instead. (Chosen behavior tested + documented in §9.)

**Revocation abuse / tombstone**
17. **(RT-2.1)** Revoked owner's pubkey can never be re-added (`authority-tombstoned`) nor re-recovered.
18. **(RT-2.8)** Revoked signer replays an old add-owner: rejected `replay` on ALL peers regardless of linearization (tombstone `lastSequence` floor).
19. **(RT-1.4)** Concurrent revoke + a grant signed by the to-be-revoked owner: on peers ordering grant-before-revoke the grant applies then revocation removes the grantor; assert convergence and that the grant is NOT retroactively undone (documented behavior) — plus a variant where the grant orders after revoke → rejected `not-owner`.

**Cascade / phantom**
20. **(RT-2.5/1.10)** remove-writer of a role-holder → `revoke-role-first`; after explicit revoke, remove succeeds; owners Map never retains a writerless entry.

**Per-signer replay**
21. Same signer reusing a sequence → `replay`. Two DIFFERENT owners both `sequence=5` post-activation → both accepted.
22. Concurrent add-admin from two owners → Maps order-independent, all peers converge on identical `owners`/`admins`/`sequences`/`revokedAuthorities`.

**Candidate channel binding**
23. `reduceOwnerCandidates` drops an entry whose `candSig` fails against its `writerKey`; keeps a self-signed one; LWW by `updatedAt`; honors `nonce`.
24. **(RT-1.5)** A candidate advertised under another writer's writerKey (forged) is dropped.
25. **(RT-2.7)** Candidate rotated (new nonce) after promote is minted → in-flight promotion with stale `candidateNonce` is invalidated; promotion stays `pending` until ack.

**Epoch coupling**
26. **(RT-3.1)** Promote a writer that missed an epoch rotation: add-owner without a valid current-epoch `subjectEpochGrant` → `stale-epoch-grant`; with the grant, the promoted co-owner can subsequently execute a member-removal re-key successfully.
27. **(RT-2.11)** revoke-admin triggers epoch rotation; a joiner admitted by that admin's outstanding invite can no longer decrypt post-rotation content.
28. **(RT-3.12)** Re-key with a pinned root writer lacking a usable epoch pubkey → un-grantable pinned writer excluded from the grant-completeness check; removal of some OTHER writer still succeeds.

**Beacon / gate**
29. `reduceCaps` verifies sigs, drops forged/mismatched-id beacons (RT-1.7).
30. One current writer advertises an incompatible/absent version → `meshSupportsMultiOwner=false`; promote/non-root add-writer append guard refuses.
31. **(RT-1.6)** A brand-new upgraded writer within grace does NOT flip the gate closed; a writer past grace with no beacon does (until root-removed).

**Recovery**
32. **(RT-3.4)** Each promoted authority's recovery code yields a distinct code; generalized `recoverOwnerAuthority` restores a co-owner/admin authority by matching the accepted-authority set for that base; rejects a code for a pubkey not in the set; **rejects a tombstoned pubkey's code**; **refuses to silently overwrite** an existing distinct local authority.

**Migration edge**
33. **(RT-2.6)** Two bootstrap records in a log → second always `owner-exists` regardless of replay start index; the `owners.size===0` fallback never authorizes an add-owner.

**Integration (private DHT)**
34. 2-peer mesh, peer B on OLD reducer: B never advertises a compatible beacon → peer A refrains from any multi-owner write → identical linearized view heads (no fork).
35. Full promotion round-trip: A(root) promotes B to co-owner via candidate channel (with fingerprint confirm + ack); B admits C as a writer; all three converge on identical roster/writer set/`revokedAuthorities`.

**Cross-app:** mobile `npm run typecheck` + `check:i18n` (6 locales); desktop `?mock=1` browser-verify of role badges/promote-with-fingerprint/revoke/per-authority recovery/low-redundancy banner; `npm run lint` (no raw console, no bare-* in renderer).

---

## 8. Implementation order (by rollout safety)

**Phase A — read side, safe to ship immediately (mesh stays byte-identical; NO device promotes or non-root-writes yet).**
1. `listam-packages/backend/lib/membership.mjs`: state shape (owners/admins/sequences/revokedAuthorities), 4 action constants, auth helpers (`isOwnerAuthority`/`canGrantRoles`/`nextSeqFor`/`isRevoked`), per-signer sequence, 4 reduce branches with ALL guards (root/last-owner, tombstone, mandatory not-a-writer, epoch-grant, cascade `revoke-role-first`, `_meshMultiOwnerActivated`), HARD `normalizeMembershipBody` field gates, signing-payload extension, roster superset. *(listam-packages)*
2. `listam-packages/backend/lib/owner-candidates.mjs` (NEW) + `domain/labels.mjs` predicate/constants folded into `isLabelItem`. *(listam-packages)*
3. `listam-packages/backend/lib/caps.mjs` (NEW): signed/versioned beacon build/reduce + fail-safe `meshSupportsMultiOwner`; `isCapItem` into `isLabelItem`. *(listam-packages)*
4. Per-base authority storage in `secrets` (`authorityByBase` map) + `network.mjs` reads/writes; generalized+tombstone-checked+no-clobber `recoverOwnerAuthority`. *(listam-packages)*
5. `network.mjs`/`shared-base.mjs`/`rekey.mjs`: per-signer `nextMembershipSequence` args; widened `canCreateMembershipInvite`; `broadcastMembershipRoster` extras + `administrability`; revoke-admin epoch rotation hook. *(listam-packages)*
6. `protocol/index.mjs`(+`.d.ts`): RPC 35–39. *(listam-packages)*
7. `backend.mjs`: 5 RPC cases, roster-rebroadcast for role effects, keep board-config root-pinned, `enqueueWrite`-serialized promote path, two-phase ack. *(listam-packages)*
8. i18n keys, all 6 locales +`.d.ts`. *(listam-packages)*
9. Test matrix §7 (all reducer/candidate/caps/recovery unit tests + integration 34). *(listam-packages)*
10. **npm publish `@listam/*`; upgrade/reinstall headless FIRST**, then desktop + mobile ship the read-side + gated-off UI. UI shows role badges (read-only) but promote/revoke controls are present-but-disabled until `meshSupportsMultiOwner`. *(listam-headless, listam-desktop, listam-mobile)*
   - Desktop: `src/store.mjs`, `src/ui.mjs`, `mock-backend.mjs`.
   - Mobile: `devicesSlice.ts`, `MembersDialog.tsx`, `index.tsx`, `_useWorklet.ts`.
   - Headless: `headless.mjs`, `src/service.mjs`.

**Phase B — write side, gated per base (only after Phase A is provably on EVERY writer of that base).**
11. Per base: confirm `meshSupportsMultiOwner` green; root-remove any permanently-offline un-upgraded writer (legacy-safe).
12. Enable Make-co-owner/Make-admin (with fingerprint confirm + recovery-ack) and admin-signed/non-root add-writer. First grant flips `_meshMultiOwnerActivated`.
13. Integration test 35 (full round-trip) on a fresh all-upgraded mesh before enabling on any production base.

**Commit boundary:** each repo (`listam-packages`, `listam-desktop`, `listam-mobile`, `listam-headless`) gets its own commit. Phase A ships to all repos (incl. an npm publish of `@listam/*`) before any Phase B enablement.

---

## 9. Residual risks (explicit)

**Medium — product-accepted, surfaced in UI, not fully code-defended:**
- **R1 — Board-config stays root-pinned (RT-1.9).** A project whose root authority is lost (a recorded real occurrence: base 42fc0b1b) can have fully functional multi-owner *writer* administration but permanently frozen *board configuration*. Mitigation shipped: the roster/UI explicitly labels board-config as ROOT-only (distinct from co-owner) so the asymmetry is visible. Widening board-config to co-owners is deferred pending product sign-off.
- **R2 — Rogue co-owner group-seizure / revoke-storm (RT-2.4).** Product rule 3 makes any single owner key a full-group-takeover primitive (a rogue co-owner can revoke all non-root co-owners/admins; with an inert root it becomes de-facto sole admin). Mitigation shipped: every promote/revoke broadcasts an audit entry in the roster feed; a compromised co-owner key is a documented trust assumption. A quorum/threshold-revoke or cool-down/undo window is deferred pending product input.
- **R3 — Concurrent mutual-revoke collapses redundancy below the intended floor (RT-3.3).** The last-owner guard stops the transition *into* size 1, not an aggregate 3→1 via independent concurrent revokes. Chosen behavior: allow it, test it, and surface a low-redundancy warning; a compare-and-swap-on-owner-set-hash revoke is deferred.
- **R4 — Concurrent grant by a to-be-revoked owner survives (RT-1.4).** A grant that linearizes before its grantor's revocation takes effect and is NOT retroactively cascaded-undone. Documented + tested behavior; an owner must re-revoke any downstream grant. A revocation-epoch cascade is out of scope for v1.
- **R5 — Recovery-code attack surface scales with owner/admin count (RT-2.12).** N codes instead of 1; admins' lower-value codes may be stored carelessly. Mitigation shipped: tombstone check + no-silent-clobber + per-base scoping + forced recovery-ack. Requiring an owner co-sign for admin-tier recovery is deferred.
- **R6 — First-grant append gate is client-side (RT-2.5 honest note).** `_meshMultiOwnerActivated` is false at the instant of the very first grant, so that single write relies on the client-side beacon check being correct. Every *subsequent* multi-owner write is consensus-gated by the linearized flag. Residual exposure is one write by a bug-free gated client on a mesh the beacon already shows fully upgraded — the smallest possible window, and the beacon is signed/verified so it cannot be spoofed open.

**Low:**
- **R7 — Recovered-but-revoked device UX (RT-1.10).** Fully defended for safety (roster `selfRole`/`canManageOwners` derive from the linearized Map, not the local keypair; tombstone rejects the recovery outright). Residual is purely cosmetic and eliminated by the tombstone check on recovery.
- **R8 — Silent membership-op loss surfaced (RT-2.3/3.8).** A non-root owner's op dropped as `replay`/`last-owner`/`not-authorized` at apply time now flows back to the initiating UI via the `enqueueWrite` re-read + ack path, so the operator learns of failure instead of assuming success. Residual: pre-existing single-owner apply-side rejections that predate this feature remain log-only unless they pass through the new op.

---

Plan complete. Key source anchors used: `membership.mjs` (:8,:18,:31,:71,:210,:230,:245,:247,:259,:263-273,:336-342,:356,:396,:413-415), `backend.mjs` (:76,:418-447,:827,:1151,:1508-1541,:1573,:1585), `network.mjs` (:262-354,:803,:1062,:1080,:1099-1107), `shared-base.mjs` (:274,:322-574), `rekey.mjs` (:70,:90-130,:188), `key-epochs.mjs`, `view-checkpoint.mjs` (:11-76), `shared-creds.mjs` (:79), `domain/labels.mjs` (:64-66), `protocol/index.mjs` (:77).
