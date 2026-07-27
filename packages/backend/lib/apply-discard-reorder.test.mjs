// Release 2.1, second harness: does `apply` ever APPLY an operation and then
// DISCARD it when Autobase re-linearizes?
//
// apply-reorder.test.mjs answers a different question — whether apply's
// ACCUMULATED list diverges from a rebuild of the committed view — and it is
// green, because `applyOperationToList` is id-keyed LWW and therefore
// order-insensitive. That mitigation is real, and it is why the projection
// invariant cannot see the residual risk.
//
// The residual risk is per-operation, not per-list: an op that apply admits in
// one linearization and REFUSES in another. Every refusal in apply is a bare
// `continue` — but by then the op may already have produced a view entry and,
// worse, an RPC frame the frontend has consumed. Autobase undoes the view; it
// does not un-emit a frame.
//
// Two of those consequences have since been repaired, and their tests are green
// rather than todo:
//   - CONVERGENCE: a row announced on a discarded timeline is retracted, so the
//     frontend converges on the committed view (lib/announce.mjs).
//   - SETTLED EFFECT: the active epoch key follows committed membership state
//     instead of the pass that installed it (lib/epoch-keyring.mjs).
// `host.addWriter`/`removeWriter` cannot be moved out — autobase asserts
// "System changes are only allowed in apply" — and they are its own state, rolled
// back with the view.
//
// What is still RED is the VERDICT itself, which is 2.1 proper and a consensus
// change: a peer that admits an op an older peer drops forks the mesh, so it
// needs a rollout plan rather than a commit.
//
// So the invariant here is not about state, it is about DECISIONS:
//
//     for a fixed set of nodes, apply's admit/refuse decision for each op must
//     not depend on the order the nodes are presented in.
//
// That is testable directly and deterministically. Autobase's documented
// behaviour is to truncate the view back to the fork point and re-run apply
// over the reordered nodes; these tests do exactly that, with a view we control,
// so the reorder is staged rather than raced. Each test states the real-world
// concurrency that produces its two orders.
//
// These tests are RED while the defect stands. That is the point: they are the
// executable definition of "done" for 2.1.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import {
    openSharedBase,
    closeSharedBase,
    bootstrapSharedOwner,
    setupSharedPairing,
    createSharedInvite,
    joinSharedBaseViaInvite,
} from './shared-base.mjs'
import { addItem, clearWriteChain, prepareListAppendOperation } from './item.mjs'
import { setRpc } from './state.mjs'
import { setRolloutFlag, resetRolloutFlags } from './rollout.mjs'
import { RPC_DELETE_FROM_BACKEND } from '@listam/protocol'
import { apply } from '../backend.mjs'
import { createListOperation } from './list-reducer.mjs'
import { createBoardConfigRecord } from './board-config.mjs'
import { createViewCheckpoint } from './view-checkpoint.mjs'
import {
    createAddWriterMembershipRecord,
    createRemoveWriterMembershipRecord,
    nextMembershipSequence,
} from './membership.mjs'
import {
    createEncryptedListOperation,
    createEpochEncryptionKeyPair,
    createEpochGrants,
    decryptEpochGrantForWriter,
    epochPublicKeyHex,
    generateEpochKey,
} from './key-epochs.mjs'

setBackendFs(fs)

function mkdir () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-discard-'))
}

// Items must satisfy normalizeListItem or createListOperation returns null and
// the whole test would run against an empty operation. (It did, in an earlier
// draft: the "encrypted" op was JSON `null`, every pass refused it, and the
// control passed for exactly the wrong reason.)
function item (fields) {
    return { isDone: false, timeOfCompletion: 0, updatedAt: Date.now(), ...fields }
}

// A view we own, with the two operations Autobase performs on the real one:
// append (during apply) and truncate-to-fork-point (before a re-apply).
function makeView (seed = []) {
    const entries = [...seed]
    return {
        entries,
        get length () { return entries.length },
        async get (i) { return entries[i] },
        async append (entry) { entries.push(entry) },
    }
}

async function snapshotView (view) {
    const out = []
    for (let i = 0; i < view.length; i++) out.push(await view.get(i))
    return out
}

// Ground truth: a from-scratch reduction of the COMMITTED view, sharing no
// state with anything apply has been mutating.
//
// `allItems()`, not `items()`: the latter is the DEFAULT bucket only, and every
// item here lives in a named list. Asserting a board ticket's fate against the
// default bucket is the trap that made an earlier round of this work read a
// re-bucketed item as a deleted one.
async function rebuildFromView (ctx) {
    const checkpoint = createViewCheckpoint()
    const { allItems } = await checkpoint.update(ctx.autobase.view, { onError: () => {} })
    return allItems
}

// One apply pass over `nodes`, against a view truncated back to `forkPoint`.
// Returns everything a rollback would have to undo: the view entries apply
// appended, the RPC frames it emitted, and the consensus-layer calls it made.
async function runPass (ctx, nodes, forkPoint) {
    const frames = []
    setRpc({
        request: (command) => ({
            command,
            send: (data) => {
                let payload = null
                try { payload = JSON.parse(data) } catch { payload = data }
                frames.push({ command, payload })
            },
        }),
    })
    const view = makeView(forkPoint)
    const hostCalls = []
    const host = {
        addWriter: async (key) => { hostCalls.push({ fn: 'addWriter', key: key.toString('hex') }) },
        removeWriter: async (key) => { hostCalls.push({ fn: 'removeWriter', key: key.toString('hex') }) },
        removeable: () => true,
    }
    await apply(ctx, nodes.map((value) => ({ value })), view, host)
    setRpc(null)
    return {
        appended: view.entries.slice(forkPoint.length),
        frames,
        hostCalls,
    }
}

const hasItemEntry = (appended, id) => appended.some((e) => e?.item?.id === id || e?.id === id)
const hasItemFrame = (frames, id) => frames.some((f) => f.payload?.id === id)
const membershipSequences = (appended) => appended
    .filter((e) => e?.op === 'membership')
    .map((e) => e.record?.sequence)

async function ownedBase (t) {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = mkdir()
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    await bootstrapSharedOwner(ctx)
    await ctx.autobase.update()
    t.after(async () => {
        setRpc(null)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })
    // The committed prefix both passes fork from: whatever real apply already
    // wrote for the bootstrap (the persisted membership record), so
    // membershipState — and the owner-authority check every signed record is
    // verified against — rebuilds exactly as it does in production.
    return { ctx, forkPoint: await snapshotView(ctx.autobase.view) }
}

// ---------------------------------------------------------------------------
// CANDIDATE 3 — a rigorOn false -> true transition on a base that had been
// running with rigor OFF.
//
// Reachable with two ordinary writers, no fork and no exotic state: the owner
// flips rigor back on while a second writer, partitioned, adds a board ticket
// that was legal under rigor-off (the write-time gate in addItem reads the same
// rigor flag, so it lets the ticket through). The second writer applies its own
// branch first ([add, config]); after the merge Autobase may order the owner's
// config op first ([config, add]).
// ---------------------------------------------------------------------------
const boardConfigNode = (ctx, rigorOn, sequence, createdAt = Date.now()) => createBoardConfigRecord({
    ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
    baseKey: ctx.autobase.key,
    config: { rigorOn },
    sequence,
    createdAt,
})

const sparseTicket = (id, extra = {}) => item({
    id, text: 'Fix the sink', listId: 'work', listType: 'board', status: 'todo', ...extra,
})
const rigorousTicket = (id) => item({
    id,
    text: 'Fix the sink',
    listId: 'work',
    listType: 'board',
    status: 'todo',
    description: 'The trap leaks',
    checklist: [{ text: 'Buy a new trap' }],
    estimatedHours: 2,
    estimatedComplexity: 20,
})

function boardAddOp (ctx, ticket) {
    const op = createListOperation('add', ticket, { listId: 'work', listType: 'board' })
    assert.ok(op, 'PRECONDITION: the ticket must survive normalizeListItem')
    return prepareListAppendOperation(op, ctx)
}

// With the rollout flag ON — the behaviour a later release enables once the mesh
// is known to understand it. The verdict becomes a pure function of two fixed
// timestamps, so it no longer depends on where the config lands relative to the
// add. This is the executable definition of done for candidate 3.
test('SETTLED VERDICT: a ticket written before rigor was turned on is admitted in BOTH orders', async (t) => {
    setRolloutFlag('rigorNotRetroactive', true)
    t.after(() => resetRolloutFlags())

    const { ctx, forkPoint } = await ownedBase(t)
    const writtenAt = Date.now()
    // Rigor was off when the ticket was written, and turned on a second later.
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1, writtenAt - 1000) })
    const ticket = sparseTicket('ticket-settled', { timestamp: writtenAt })
    const addOp = boardAddOp(ctx, ticket)
    const rigorOn = boardConfigNode(ctx, true, 2, writtenAt + 1000)

    for (const [name, nodes] of [['add first', [addOp, rigorOn]], ['config first', [rigorOn, addOp]]]) {
        const pass = await runPass(ctx, nodes, forkPoint)
        assert.equal(hasItemEntry(pass.appended, ticket.id), true,
            `a ticket that was legal when written must survive this linearization (${name})`)
    }
})

test('SETTLED VERDICT: a ticket written AFTER rigor was turned on is still refused', async (t) => {
    // Non-vacuity for the test above: the flag makes the gate non-retroactive,
    // it does not switch the gate off. Without this, "admitted in both orders"
    // could just mean rigor stopped being enforced at all.
    //
    // Both config records are COMMITTED here, so there is no ordering variable —
    // this measures enforcement, not order-independence.
    setRolloutFlag('rigorNotRetroactive', true)
    t.after(() => resetRolloutFlags())

    const { ctx, forkPoint } = await ownedBase(t)
    const turnedOnAt = Date.now()
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1, turnedOnAt - 1000) })
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, true, 2, turnedOnAt) })

    const after = sparseTicket('ticket-after-rigor', { timestamp: turnedOnAt + 1000 })
    assert.equal(hasItemEntry((await runPass(ctx, [boardAddOp(ctx, after)], forkPoint)).appended, after.id), false,
        'a sparse ticket written under rigor-on must still be refused')

    const before = sparseTicket('ticket-before-rigor', { timestamp: turnedOnAt - 500 })
    assert.equal(hasItemEntry((await runPass(ctx, [boardAddOp(ctx, before)], forkPoint)).appended, before.id), true,
        'a sparse ticket written before the transition must be admitted')
})

// The stamp closes what timestamps cannot.
//
// Same scenario as KNOWN RESIDUAL below — a writer whose clock is past the
// transition but which had NOT seen the rigor-on config — except the ticket
// records which config the writer had. The verdict then depends only on the op
// and a causally-prior record, so both orders agree.
test('STAMPED VERDICT: a ticket stamped with the config its writer had is admitted in BOTH orders', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)
    const turnedOnAt = Date.now()
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1, turnedOnAt - 1000) })
    const rigorOn = boardConfigNode(ctx, true, 2, turnedOnAt)

    // Writer had seen config seq 1 (rigor off) and nothing later. Its wall clock
    // is past the transition, which is exactly what defeats the timestamp rule.
    const ticket = sparseTicket('ticket-stamped', { timestamp: turnedOnAt + 1000, boardConfigSeq: 1 })
    const addOp = boardAddOp(ctx, ticket)

    for (const [name, nodes] of [['add first', [addOp, rigorOn]], ['config first', [rigorOn, addOp]]]) {
        const pass = await runPass(ctx, nodes, forkPoint)
        assert.equal(hasItemEntry(pass.appended, ticket.id), true,
            `a ticket stamped under rigor-off must be admitted (${name})`)
    }
})

test('STAMPED VERDICT: a ticket stamped with a rigor-ON config is refused', async (t) => {
    // Non-vacuity: the stamp must not be a blanket bypass. A writer that HAD seen
    // rigor-on is held to it — note the timestamp here PREDATES the transition,
    // so the timestamp rule alone would have let this through.
    //
    // Only reachable orders are exercised. A stamp names a record the writer had
    // already seen, which is therefore causally prior and precedes the ticket in
    // EVERY linearization — "add before the config it claims to have seen" is not
    // a history autobase can produce, so it is not a case to assert on.
    const turnedOnAt = Date.now()
    const ticket = () => sparseTicket('ticket-stamped-on', { timestamp: turnedOnAt - 5000, boardConfigSeq: 2 })

    // Resolved from the committed view.
    const committed = await ownedBase(t)
    committed.forkPoint.push({ op: 'board-config', record: boardConfigNode(committed.ctx, false, 1, turnedOnAt - 1000) })
    committed.forkPoint.push({ op: 'board-config', record: boardConfigNode(committed.ctx, true, 2, turnedOnAt) })
    const fromView = await runPass(committed.ctx, [boardAddOp(committed.ctx, ticket())], committed.forkPoint)
    assert.equal(hasItemEntry(fromView.appended, 'ticket-stamped-on'), false,
        'a ticket stamped under rigor-on must be refused when the config is already committed')

    // Resolved from a record accepted earlier in the SAME pass.
    const sameBatch = await ownedBase(t)
    sameBatch.forkPoint.push({ op: 'board-config', record: boardConfigNode(sameBatch.ctx, false, 1, turnedOnAt - 1000) })
    const rigorOn = boardConfigNode(sameBatch.ctx, true, 2, turnedOnAt)
    const inBatch = await runPass(sameBatch.ctx, [rigorOn, boardAddOp(sameBatch.ctx, ticket())], sameBatch.forkPoint)
    assert.equal(hasItemEntry(inBatch.appended, 'ticket-stamped-on'), false,
        'a ticket stamped under rigor-on must be refused when the config arrives in the same pass')
})

test('STAMPED VERDICT: a compliant ticket is admitted whatever it is stamped with', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)
    const rigorOn = boardConfigNode(ctx, true, 1, Date.now())
    const ticket = rigorousTicket('ticket-stamped-good')
    ticket.boardConfigSeq = 1
    const pass = await runPass(ctx, [rigorOn, boardAddOp(ctx, ticket)], forkPoint)
    assert.equal(hasItemEntry(pass.appended, ticket.id), true)
})

test('WRITE SIDE: addItem stamps the config it has seen, only when the flag is on', async (t) => {
    const { ctx } = await ownedBase(t)
    const complete = {
        description: 'The trap leaks',
        checklist: [{ text: 'Buy a new trap' }],
        estimatedHours: 2,
        estimatedComplexity: 20,
    }

    const stampOf = async (text) => {
        const frames = []
        setRpc({
            request: (command) => ({
                command,
                send: (data) => {
                    try { frames.push(JSON.parse(data)) } catch { /* non-item frame */ }
                },
            }),
        })
        assert.equal(await addItem(text, 'work', 'board', complete, ctx), true, 'the compliant add must be accepted')
        await ctx.autobase.update()
        setRpc(null)
        const row = frames.find((f) => f?.text === text)
        assert.ok(row, `the frontend must have been told about ${text}`)
        return row.boardConfigSeq
    }

    assert.equal(await stampOf('unstamped'), undefined, 'nothing is stamped while the flag is off')

    setRolloutFlag('stampBoardConfigOnWrite', true)
    t.after(() => resetRolloutFlags())
    // No board-config record on this base, so the writer is on the default: 0.
    assert.equal(await stampOf('stamped'), 0, 'the seen config sequence is recorded')
})

// The part the timestamp rule does NOT close, stated rather than glossed.
//
// A peer that has not yet seen the rigor-on config writes a sparse ticket, so
// its wall-clock stamp lands AFTER the transition even though the writer could
// not have known. Whether the gate fires then still depends on whether the
// config is in the prefix when the add is evaluated — which differs by
// linearization AND by how autobase happens to batch the nodes.
//
// Closing this needs the causal-past rule: "was the config in the op's causal
// past" is intrinsic to the two records, where "is it in the prefix" is not.
// Until then the announcement retraction makes it recoverable rather than silent.
test('KNOWN RESIDUAL: a ticket written concurrently with the rigor-on config is still order-dependent', { todo: 'closed by the stamp (STAMPED VERDICT above); RED until stampBoardConfigOnWrite flips and writers stamp' }, async (t) => {
    setRolloutFlag('rigorNotRetroactive', true)
    t.after(() => resetRolloutFlags())

    const { ctx, forkPoint } = await ownedBase(t)
    const turnedOnAt = Date.now()
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1, turnedOnAt - 1000) })
    const rigorOn = boardConfigNode(ctx, true, 2, turnedOnAt)
    // Written by a peer that had not seen `rigorOn`, but whose clock is past it.
    const ticket = sparseTicket('ticket-concurrent', { timestamp: turnedOnAt + 1000 })
    const addOp = boardAddOp(ctx, ticket)

    const addFirst = await runPass(ctx, [addOp, rigorOn], forkPoint)
    const configFirst = await runPass(ctx, [rigorOn, addOp], forkPoint)
    assert.equal(
        hasItemEntry(addFirst.appended, ticket.id),
        hasItemEntry(configFirst.appended, ticket.id),
        'the verdict must not depend on where the concurrent config lands',
    )
})

test('SETTLED VERDICT: the gate still applies to everything on a board that never left the default', async (t) => {
    // rigorOnSince is 0 on the default config, so "created at or after the
    // transition" is true for every ticket — a fresh board keeps enforcing.
    setRolloutFlag('rigorNotRetroactive', true)
    t.after(() => resetRolloutFlags())

    const { ctx, forkPoint } = await ownedBase(t)
    const ticket = sparseTicket('ticket-default-board', { timestamp: Date.now() })
    const pass = await runPass(ctx, [boardAddOp(ctx, ticket)], forkPoint)
    assert.equal(hasItemEntry(pass.appended, ticket.id), false,
        'a board that never turned rigor off must gate every ticket')
})

test('CONTROL: order is the only thing that changes the verdict', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1) })
    const rigorOn = boardConfigNode(ctx, true, 2)

    // A rigor-COMPLIANT ticket is admitted in both orders. Without this the
    // suite could not tell "the reorder refused it" from "board adds never get
    // through this harness at all".
    const good = rigorousTicket('ticket-compliant')
    const goodOp = boardAddOp(ctx, good)
    assert.equal(hasItemEntry((await runPass(ctx, [goodOp, rigorOn], forkPoint)).appended, good.id), true,
        'a compliant ticket must be admitted with the add first')
    assert.equal(hasItemEntry((await runPass(ctx, [rigorOn, goodOp], forkPoint)).appended, good.id), true,
        'a compliant ticket must be admitted with the config first')

    // A sparse ticket on a base that never left rigor-on is refused in both
    // orders — the verdict is stable when the rigor flag does not move.
    const alwaysOn = await ownedBase(t)
    const bad = sparseTicket('ticket-always-rigor')
    const badOp = boardAddOp(alwaysOn.ctx, bad)
    const stillOn = boardConfigNode(alwaysOn.ctx, true, 1)
    assert.equal(hasItemEntry((await runPass(alwaysOn.ctx, [badOp, stillOn], alwaysOn.forkPoint)).appended, bad.id), false)
    assert.equal(hasItemEntry((await runPass(alwaysOn.ctx, [stillOn, badOp], alwaysOn.forkPoint)).appended, bad.id), false)
})

// ---------------------------------------------------------------------------
// CANDIDATE 2 — an epoch-key mismatch mid-history.
//
// `unwrapListOperation` refuses any encrypted op whose epoch tag is not the
// CURRENT epoch, and the current epoch advances inside the node loop when a
// re-key (remove-writer) record is reduced. So the same op is decryptable or
// not depending on which side of the re-key it lands on.
//
// Reachable with two ordinary writers: the owner removes a member (rotating the
// epoch) while another writer, partitioned, keeps writing at the old epoch.
// ---------------------------------------------------------------------------
async function baseWithSecondWriter (t) {
    const { ctx, forkPoint } = await ownedBase(t)

    // A second writer, so a removal has someone to remove and the re-key has a
    // grant set to satisfy.
    const other = crypto.keyPair()
    const addWriter = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        writerKey: other.publicKey,
        baseKey: ctx.autobase.key,
        sequence: nextMembershipSequence(ctx.membershipState),
        epochPublicKey: epochPublicKeyHex(createEpochEncryptionKeyPair()),
    })
    const seeded = await runPass(ctx, [addWriter], forkPoint)
    assert.equal(seeded.appended.some((e) => e?.op === 'membership'), true,
        'PRECONDITION: the second writer must be admitted')
    forkPoint.push(...seeded.appended)

    return { ctx, forkPoint, other }
}

// A re-key (remove-writer) record removing `victim`, granting the new epoch key
// to the owner, who is the only writer left afterwards.
function rekeyRecord (ctx, { victim, sequence }) {
    const epochKey = generateEpochKey()
    const currentEpoch = Number(ctx.membershipState.currentEpoch) || 1
    return createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        writerKey: victim,
        baseKey: ctx.autobase.key,
        sequence,
        previousEpoch: currentEpoch,
        epoch: currentEpoch + 1,
        epochKey,
        epochGrants: createEpochGrants({
            epochKey,
            recipients: [{
                writerKey: ctx.autobase.local.key.toString('hex'),
                epochPublicKey: epochPublicKeyHex(ctx.epochEncryptionKeyPair),
            }],
        }),
    })
}

test('DISCARD: a list op admitted at the current epoch is refused when the re-key reorders ahead of it', { todo: 'RED until Release 2.1 makes apply deterministic; the assertion below is the definition of done' }, async (t) => {
    const { ctx, forkPoint, other } = await baseWithSecondWriter(t)

    // An ordinary item, encrypted and tagged with the epoch live at write time.
    const row = item({ id: 'item-epoch', text: 'Milk', listId: 'default', listType: 'shopping' })
    const listOp = createListOperation('add', row, { listId: 'default', listType: 'shopping' })
    const addOp = prepareListAppendOperation(listOp, ctx)
    assert.equal(Number(addOp.epoch) > 0, true, 'PRECONDITION: the op must be epoch-tagged (encryption active)')

    const rekey = rekeyRecord(ctx, { victim: other.publicKey, sequence: nextMembershipSequence(ctx.membershipState) })

    // Accepting a re-key moves the active epoch key. That is now reconciled from
    // committed state at the end of each pass (SETTLED EFFECT below), so nothing
    // has to be restored by hand here — this test measures the ordering effect
    // alone.

    const first = await runPass(ctx, [addOp, rekey], forkPoint)
    assert.equal(hasItemEntry(first.appended, row.id), true,
        'PRECONDITION: the add must be admitted at the epoch it was written under')
    assert.equal(hasItemFrame(first.frames, row.id), true,
        'PRECONDITION: the frontend must have been told about the add')
    assert.equal(first.hostCalls.some((c) => c.fn === 'removeWriter'), true,
        'PRECONDITION: the re-key must actually have removed the writer')

    const second = await runPass(ctx, [rekey, addOp], forkPoint)
    assert.equal(
        hasItemEntry(second.appended, row.id),
        true,
        'APPLIED THEN DISCARDED: the same add is admitted before the re-key and refused after it. ' +
        'The frontend already has the row; the committed view does not.',
    )
})

test('SETTLED EFFECT: a rolled-back re-key gives the context its previous epoch key back', async (t) => {
    const { ctx, forkPoint, other } = await baseWithSecondWriter(t)
    const rekey = rekeyRecord(ctx, { victim: other.publicKey, sequence: nextMembershipSequence(ctx.membershipState) })
    const before = Buffer.from(ctx.epochKey)

    // Pass 1 accepts the re-key. Pass 2 is the same fork point with the re-key
    // rolled back out of history entirely — the branch that carried it lost.
    const accepted = await runPass(ctx, [rekey], forkPoint)
    assert.equal(accepted.hostCalls.some((c) => c.fn === 'removeWriter'), true,
        'PRECONDITION: the re-key must have been accepted')
    assert.equal(before.equals(Buffer.from(ctx.epochKey)), false,
        'PRECONDITION: accepting the re-key must have installed the new epoch key')

    await runPass(ctx, [], forkPoint)
    assert.equal(
        before.equals(Buffer.from(ctx.epochKey)),
        true,
        'the epoch key must follow the committed membership state, not the pass that installed it',
    )
})

// The regression this refactor nearly introduced. Deferring adoption to the end
// of the pass means the ACTIVE key still names the old epoch while the pass is
// running — so an op written under the NEW epoch, linearized after the re-key,
// would stop decrypting. Lookup goes by the epoch's key hash for exactly this.
test('SETTLED EFFECT: an op written under the new epoch decrypts in the same pass as the re-key', async (t) => {
    const { ctx, forkPoint, other } = await baseWithSecondWriter(t)

    const rekey = rekeyRecord(ctx, { victim: other.publicKey, sequence: nextMembershipSequence(ctx.membershipState) })
    // The key the re-key grants us, encrypted for this device — the same one
    // apply will file in the keyring when it accepts the record.
    const grantedKey = decryptEpochGrantForWriter(
        rekey.epochGrants,
        ctx.autobase.local.key.toString('hex'),
        ctx.epochEncryptionKeyPair,
    )
    assert.ok(grantedKey, 'PRECONDITION: the re-key must grant this device the new epoch key')

    const row = item({ id: 'item-new-epoch', text: 'Bread', listId: 'default', listType: 'shopping' })
    const listOp = createListOperation('add', row, { listId: 'default', listType: 'shopping' })
    const newEpochOp = createEncryptedListOperation(listOp, grantedKey, rekey.epoch)
    assert.equal(Number(newEpochOp.epoch), rekey.epoch, 'PRECONDITION: the op must be tagged with the NEW epoch')

    const pass = await runPass(ctx, [rekey, newEpochOp], forkPoint)
    assert.equal(
        hasItemEntry(pass.appended, row.id),
        true,
        'an op under the newly granted epoch must decrypt in the same pass that accepted the re-key',
    )
})

// ---------------------------------------------------------------------------
// CANDIDATE 1 — writer removal at consensus.
//
// `host.removeWriter` mutates the Autobase writer set. It cannot be lifted out
// of apply (autobase asserts system changes are apply-only) and it is autobase's
// own state, rolled back with the view.
//
// The key retirement that used to ride along with it — a `deleteEpochKey()` file
// unlink, mid-loop — has been moved to the end-of-pass reconcile and made
// recoverable from the in-memory keyring. What remains RED here is only the
// verdict: the removal is accepted in one order and refused as a replay in the
// other.
//
// Reachability is narrower than the other two: every membership record carries
// the owner's signature and a monotonic sequence, so two competing membership
// records require the OWNER's writer to fork (restore-from-backup, or the same
// writer key opened from two stores). That precondition is stated here rather
// than assumed away.
// ---------------------------------------------------------------------------
test('DISCARD: an accepted writer removal is refused as a replay when a higher-sequence re-key reorders ahead of it', { todo: 'RED until Release 2.1 makes apply deterministic; the assertion below is the definition of done' }, async (t) => {
    const { ctx, forkPoint, other } = await baseWithSecondWriter(t)
    const seq = nextMembershipSequence(ctx.membershipState)

    // Two owner-signed re-keys minted from the same epoch on a forked owner
    // writer: both claim previousEpoch = current, at different sequences.
    const removeLow = rekeyRecord(ctx, { victim: other.publicKey, sequence: seq })
    const removeHigh = rekeyRecord(ctx, { victim: other.publicKey, sequence: seq + 1 })

    const first = await runPass(ctx, [removeLow, removeHigh], forkPoint)
    assert.deepEqual(membershipSequences(first.appended), [seq],
        'PRECONDITION: the low-sequence removal wins when it is presented first')
    assert.equal(first.hostCalls.some((c) => c.fn === 'removeWriter'), true,
        'PRECONDITION: the accepted removal must have been executed at the consensus layer')

    const second = await runPass(ctx, [removeHigh, removeLow], forkPoint)
    assert.deepEqual(
        membershipSequences(second.appended),
        [seq],
        'APPLIED THEN DISCARDED: apply accepted the sequence-' + seq + ' removal in one linearization — ' +
        'calling host.removeWriter — and refused it as a replay in another.',
    )
})

// The five tests above are marked `todo`, so node:test reports them without
// failing the run while the defect stands. That is the only way a known-red
// regression suite can land without breaking CI — but it also means their
// PRECONDITION assertions stop being enforced: if the staging rotted, they would
// go on reporting "todo" and nobody would notice the suite had stopped proving
// anything.
//
// This test is NOT todo. It re-asserts, cheaply, that each staging still puts a
// real operation in front of apply and that apply still admits it in the first
// order. If this goes red, the todo tests above are measuring nothing.
test('HARNESS INTEGRITY: each staged scenario really is admitted in its first order', async (t) => {
    const rigor = await ownedBase(t)
    rigor.forkPoint.push({ op: 'board-config', record: boardConfigNode(rigor.ctx, false, 1) })
    const ticket = sparseTicket('ticket-integrity')
    const rigorPass = await runPass(
        rigor.ctx,
        [boardAddOp(rigor.ctx, ticket), boardConfigNode(rigor.ctx, true, 2)],
        rigor.forkPoint,
    )
    assert.equal(hasItemEntry(rigorPass.appended, ticket.id), true,
        'candidate 3 staging: a sparse board add must still be admitted under rigor-off')
    assert.equal(hasItemFrame(rigorPass.frames, ticket.id), true,
        'candidate 3 staging: the add must still reach the frontend')

    const epoch = await baseWithSecondWriter(t)
    const row = item({ id: 'item-integrity', text: 'Milk', listId: 'default', listType: 'shopping' })
    const addOp = prepareListAppendOperation(
        createListOperation('add', row, { listId: 'default', listType: 'shopping' }),
        epoch.ctx,
    )
    assert.equal(Number(addOp.epoch) > 0, true,
        'candidate 2 staging: list ops must still be epoch-tagged, or there is no epoch to mismatch')
    const seq = nextMembershipSequence(epoch.ctx.membershipState)
    const epochPass = await runPass(
        epoch.ctx,
        [addOp, rekeyRecord(epoch.ctx, { victim: epoch.other.publicKey, sequence: seq })],
        epoch.forkPoint,
    )
    assert.equal(hasItemEntry(epochPass.appended, row.id), true,
        'candidate 2 staging: the op must still be admitted at the epoch it was written under')
    assert.equal(epochPass.hostCalls.some((c) => c.fn === 'removeWriter'), true,
        'candidate 1 staging: the re-key must still reach the consensus layer')

    const removal = await baseWithSecondWriter(t)
    const low = nextMembershipSequence(removal.ctx.membershipState)
    const removalPass = await runPass(
        removal.ctx,
        [
            rekeyRecord(removal.ctx, { victim: removal.other.publicKey, sequence: low }),
            rekeyRecord(removal.ctx, { victim: removal.other.publicKey, sequence: low + 1 }),
        ],
        removal.forkPoint,
    )
    assert.deepEqual(membershipSequences(removalPass.appended), [low],
        'candidate 1 staging: the low-sequence removal must still win when presented first')
})

// ---------------------------------------------------------------------------
// END TO END — the same discard, on a real two-writer base, with no staged
// node order at all.
//
// The tests above present node orders directly to apply. This one proves those
// orders are what Autobase actually produces. Autobase's linearizer breaks ties
// between CONCURRENT nodes in `cmpUnlinked`: `b4a.compare(a.writer.core.key,
// b.writer.core.key)` — lowest writer key first. So for two concurrent ops the
// order is fixed by the writer keys, and both of the orders staged above are
// reachable linearizations depending on which key is lower.
//
// That also makes this test deterministic instead of a coin flip: set up the
// pair until the OWNER holds the lower writer key, so the owner's rigor-on
// config is guaranteed to sort ahead of the other writer's concurrent add.
// ---------------------------------------------------------------------------
function connect (storeA, storeB) {
    const a = storeA.replicate(true)
    const b = storeB.replicate(false)
    a.pipe(b).pipe(a)
    return async () => {
        try { a.destroy() } catch {}
        try { b.destroy() } catch {}
    }
}

async function settle (ctx, rounds = 10) {
    for (let i = 0; i < rounds; i++) {
        await ctx.autobase.update()
        await new Promise((r) => setTimeout(r, 60))
    }
}

async function partition (...ctxs) {
    for (const ctx of ctxs) {
        try { if (ctx.discovery) await ctx.discovery.destroy() } catch {}
        try { if (ctx.swarm) await ctx.swarm.destroy() } catch {}
        ctx.swarm = null
        ctx.discovery = null
    }
}

// The whole scenario, run once and shared: two real writers, a deterministic
// reorder, and a ticket one peer announced to its frontend before the merge
// dropped it. The two tests below read different things from it — one asserts
// the row should never have been dropped (that is 2.1), the other asserts that
// since it WAS dropped, the frontend is told (that is this step).
async function stageRealDiscard (t, { rigorOnBeforeAdd = false } = {}) {
    const testnet = await createTestnet(3)
    const dirs = []
    const open = []
    let disconnect = null
    t.after(async () => {
        setRpc(null)
        if (disconnect) await disconnect()
        for (const ctx of open) {
            clearWriteChain(ctx)
            try { await closeSharedBase(ctx) } catch {}
        }
        await testnet.destroy()
        for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    })

    // Build the pair until the owner's writer key sorts first. Only the owner
    // can sign a board-config, so the roles cannot simply be swapped.
    let ctxA = null
    let ctxB = null
    for (let attempt = 0; attempt < 10 && !ctxB; attempt++) {
        const dirA = mkdir()
        const dirB = mkdir()
        dirs.push(dirA, dirB)
        const a = createBaseContext({ role: 'shared' })
        await openSharedBase(a, { storageDir: dirA, bootstrap: testnet.bootstrap })
        await bootstrapSharedOwner(a)
        setupSharedPairing(a)
        const invite = createSharedInvite(a)
        assert.ok(invite, 'owner minted an invite')
        const joined = await joinSharedBaseViaInvite(createBaseContext, {
            invite,
            storageDir: dirB,
            bootstrap: testnet.bootstrap,
        })
        assert.equal(joined.writable, true, 'the second peer must be an authorized writer')
        open.push(a, joined.ctx)
        if (b4a.compare(a.autobase.local.key, joined.ctx.autobase.local.key) < 0) {
            ctxA = a
            ctxB = joined.ctx
        } else {
            await partition(a, joined.ctx)
        }
    }
    assert.ok(ctxB, 'could not build a pair with the owner holding the lower writer key')

    // The board has been running with rigor OFF, and both peers know it.
    await ctxA.autobase.append(boardConfigNode(ctxA, false, 1))
    await settle(ctxA, 4)
    await settle(ctxB, 10)
    assert.equal(ctxB.boardConfigState?.config?.rigorOn, false,
        'PRECONDITION: the joined peer must have replicated the rigor-off config')

    await partition(ctxA, ctxB)

    // Partitioned, so the joined peer cannot see this either way. Appending it
    // FIRST only changes the wall clock: the ticket written afterwards carries a
    // stamp past the transition, even though its writer had no way to know.
    if (rigorOnBeforeAdd) {
        await ctxA.autobase.append(boardConfigNode(ctxA, true, 2))
        await settle(ctxA, 4)
    }

    // The joined peer adds a sparse ticket. Its own write-time rigor gate reads
    // rigorOn=false, so this is an ordinary, legal add — and its apply admits it
    // and tells its frontend.
    const frames = []
    setRpc({
        request: (command) => ({
            command,
            send: (data) => {
                let payload = null
                try { payload = JSON.parse(data) } catch { payload = data }
                frames.push({ command, payload })
            },
        }),
    })
    assert.equal(await addItem('Fix the sink', 'work', 'board', null, ctxB), true,
        'PRECONDITION: the add must be accepted while rigor is off')
    await settle(ctxB, 4)

    const announced = frames.map((f) => f.payload).find((p) => p?.text === 'Fix the sink')
    assert.ok(announced, 'PRECONDITION: the frontend must have been told about the ticket')
    assert.equal(
        (await rebuildFromView(ctxB)).some((i) => i.id === announced.id), true,
        'PRECONDITION: the ticket must be in the committed view before the merge',
    )
    assert.equal(
        frames.some((f) => f.command === RPC_DELETE_FROM_BACKEND && f.payload?.id === announced.id),
        false,
        'PRECONDITION: nothing has retracted the ticket yet',
    )

    // Meanwhile the owner turns rigor back on — after the add, so the ticket
    // predates the transition.
    if (!rigorOnBeforeAdd) {
        await ctxA.autobase.append(boardConfigNode(ctxA, true, 2))
        await settle(ctxA, 4)
    }

    disconnect = connect(ctxA.store, ctxB.store)
    await settle(ctxA, 12)
    await settle(ctxB, 12)

    // Non-vacuity: the merge really happened on B.
    assert.equal(ctxB.boardConfigState?.config?.rigorOn, true,
        'PRECONDITION: the joined peer must have merged the owner rigor-on config')

    return { ctxB, announced, frames }
}

test('END TO END SETTLED VERDICT: with the flag on, the merged history keeps the ticket', { timeout: 600_000 }, async (t) => {
    setRolloutFlag('rigorNotRetroactive', true)
    t.after(() => resetRolloutFlags())

    const { ctxB, announced, frames } = await stageRealDiscard(t)

    assert.equal(
        (await rebuildFromView(ctxB)).some((i) => i.id === announced.id),
        true,
        'the ticket was legal when written, so a merge that reorders the rigor-on config ahead of it must keep it',
    )
    // The frontend may still see churn while a multi-pass re-apply is in flight:
    // an intermediate pass can end with the row not yet re-admitted, which the
    // retraction reads as a phantom and withdraws before a later pass restores
    // it. Cosmetic, and it converges — what must hold is that the LAST thing the
    // frontend was told about this row is not "it is gone".
    const lastForRow = frames.filter((f) => f.payload?.id === announced.id).pop()
    assert.ok(lastForRow, 'the frontend must have been told something about the row')
    assert.notEqual(
        lastForRow.command,
        RPC_DELETE_FROM_BACKEND,
        'the frontend must converge on the row existing, since the committed view has it',
    )
})

test('END TO END CONVERGENCE: the discarded row is retracted on a real base', { timeout: 600_000 }, async (t) => {
    // Staged so the ticket's stamp lands AFTER the rigor-on transition, which is
    // the case the timestamp rule cannot decide (KNOWN RESIDUAL) — so a row is
    // still discarded here even with rigorNotRetroactive on, and the retraction
    // still has something to correct.
    const { ctxB, announced, frames } = await stageRealDiscard(t, { rigorOnBeforeAdd: true })

    // Non-vacuity: this test is only meaningful while the row really is dropped.
    // If 2.1 lands and the verdict stops depending on order, the todo test above
    // goes green and this one must be retired with it rather than left asserting
    // a retraction that should no longer happen.
    assert.equal(
        (await rebuildFromView(ctxB)).some((i) => i.id === announced.id),
        false,
        'PRECONDITION: the merged history must still drop the row — otherwise there is nothing to retract',
    )

    const retraction = frames.find(
        (f) => f.command === RPC_DELETE_FROM_BACKEND && f.payload?.id === announced.id,
    )
    assert.ok(retraction,
        'the frontend must be told to drop the row that a real Autobase reorg discarded')
    assert.equal(retraction.payload.listId, 'work', 'the retraction must carry the bucket the row was shown in')
    assert.equal(retraction.payload.listType, 'board')
    assert.equal(ctxB.announcementLog.has(announced.id), false,
        'the retracted row must leave the log')
})

// ---------------------------------------------------------------------------
// CONVERGENCE — the first repair, landed ahead of 2.1 proper.
//
// The verdict is still order-dependent (that is 2.1, and a consensus change that
// needs a mesh-wide rollout). What is fixed here is the part that needs no
// consensus agreement at all: the frontend no longer keeps a row the committed
// view discarded. apply retracts what it announced on the timeline that lost.
//
// This is strictly additive — the normal per-op emission path is unchanged, so
// frame ordering for the three clients is exactly what it was.
// ---------------------------------------------------------------------------
test('CONVERGENCE: a row announced on a discarded timeline is retracted after the reorg', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)
    // The residual scenario, which still discards with rigorNotRetroactive on: a
    // peer that had not seen the rigor-on config writes a sparse ticket whose
    // wall-clock stamp lands after the transition anyway. Stamps are explicit so
    // this does not depend on two Date.now() calls landing in the same
    // millisecond, which is what made an earlier version of this test pass by
    // luck once the flag flipped.
    const turnedOnAt = Date.now()
    forkPoint.push({ op: 'board-config', record: boardConfigNode(ctx, false, 1, turnedOnAt - 1000) })

    const ticket = sparseTicket('ticket-retract', { timestamp: turnedOnAt + 1000 })
    const addOp = boardAddOp(ctx, ticket)
    const rigorOn = boardConfigNode(ctx, true, 2, turnedOnAt)

    const first = await runPass(ctx, [addOp, rigorOn], forkPoint)
    assert.equal(hasItemFrame(first.frames, ticket.id), true,
        'PRECONDITION: the frontend must have been told the ticket exists')
    assert.equal(ctx.announcementLog.has(ticket.id), true,
        'PRECONDITION: the announcement must have been recorded')

    // The reorg: same fork point, the config now ahead of the add. apply refuses
    // the add, so the committed view has no such row.
    const second = await runPass(ctx, [rigorOn, addOp], forkPoint)
    assert.equal(hasItemEntry(second.appended, ticket.id), false,
        'PRECONDITION: this pass must still refuse the add — otherwise there is nothing to retract')

    const retraction = second.frames.find(
        (f) => f.command === RPC_DELETE_FROM_BACKEND && f.payload?.id === ticket.id,
    )
    assert.ok(retraction,
        'the frontend must be told to drop the row the reorg discarded')
    assert.equal(retraction.payload.listId, 'work', 'the retraction must carry the bucket the row was shown in')
    assert.equal(retraction.payload.listType, 'board')
    assert.equal(ctx.announcementLog.has(ticket.id), false,
        'the retracted row must leave the log, so it is not retracted twice')
})

test('CONVERGENCE: an ordinary pass with no reorg retracts nothing', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)

    // Non-vacuity for the test above: prove the retraction is driven by the
    // reorg, not by every pass. Two rows are added across two passes that BUILD
    // on each other (no truncation), and neither is retracted.
    const first = item({ id: 'row-1', text: 'Milk', listId: 'default', listType: 'shopping' })
    const firstOp = prepareListAppendOperation(
        createListOperation('add', first, { listId: 'default', listType: 'shopping' }), ctx,
    )
    const pass1 = await runPass(ctx, [firstOp], forkPoint)
    assert.equal(hasItemEntry(pass1.appended, first.id), true, 'PRECONDITION: the first row must be admitted')

    const grown = [...forkPoint, ...pass1.appended]
    const second = item({ id: 'row-2', text: 'Bread', listId: 'default', listType: 'shopping' })
    const secondOp = prepareListAppendOperation(
        createListOperation('add', second, { listId: 'default', listType: 'shopping' }), ctx,
    )
    const pass2 = await runPass(ctx, [secondOp], grown)
    assert.equal(hasItemEntry(pass2.appended, second.id), true, 'PRECONDITION: the second row must be admitted')

    assert.deepEqual(
        pass2.frames.filter((f) => f.command === RPC_DELETE_FROM_BACKEND).map((f) => f.payload?.id),
        [],
        'a pass that appends to unchanged history must retract nothing',
    )
    assert.equal(ctx.announcementLog.has(first.id), true, 'the earlier row must still be announced')
})
