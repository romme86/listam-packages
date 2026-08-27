// End-to-end regression for the 2026-08-26 field failure.
//
// A real backend on a private DHT, a real blind-pairing guest. What is being
// asserted is not that pairing works — that was never broken on a LAN — but that
// a REFUSED guest is TOLD, quickly.
//
// Before this remediation every host-side refusal called `candidate.close()`,
// which does not exist on blind-pairing-core's MemberRequest. It threw TypeError
// into an empty catch, no reply was ever written, and the guest sat there for the
// full 120-second deadline. "Host refused you", "host is unreachable" and "host
// never existed" were one indistinguishable spinner, which is why a field report
// from three people could only say "it didn't work".
//
// The deadline is 120s; these assertions demand an answer in a small fraction of
// that. A regression here shows up as a timeout, which is precisely the symptom.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import BlindPairing from 'blind-pairing'
import z32 from 'z32'

import { startBackend } from './backend.mjs'
import { createNodePlatform } from './platform/node.mjs'
import { createInvite } from './lib/network.mjs'
import { autobase } from './lib/state.mjs'
import { PAIRING_POLL_MS } from './lib/pairing-tuning.mjs'

// Comfortably above a healthy handshake on a local testnet, far below the 120s
// deadline whose expiry is the bug's signature.
const ANSWER_BUDGET_MS = 30_000

function mkdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-refusal-')) }

// Present a code and resolve with what the host said: paired, or a refusal
// carrying a decodable reason.
function presentInvite (swarm, code) {
    const pairing = new BlindPairing(swarm, { poll: PAIRING_POLL_MS })
    return {
        pairing,
        outcome: new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ kind: 'no-answer' }), ANSWER_BUDGET_MS)
            const done = (value) => { clearTimeout(timer); resolve(value) }

            const candidate = pairing.addCandidate({
                invite: z32.decode(code),
                userData: Buffer.from(JSON.stringify({
                    version: 1,
                    writerKey: Buffer.alloc(32, 7).toString('hex'),
                    epochPublicKey: Buffer.alloc(32, 8).toString('hex'),
                })),
                onadd: () => done({ kind: 'paired' }),
            })

            // The listener the guest used to omit entirely, which is what made
            // the host-side refusal invisible even once it was sent.
            candidate.request.on('rejected', (err) => done({ kind: 'refused', code: err?.code ?? null }))
        }),
    }
}

test('a guest presenting an already-used code is refused fast, with a reason', { timeout: 180_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const baseDir = mkdir()
    const platform = createNodePlatform({
        argv: [baseDir, '', '', ''], // no secrets -> fresh base, this node is owner
        storageNamespace: 'refusaltest',
        bootstrap: testnet.bootstrap,
        leaseTtlMs: 60000,
        reply: () => JSON.stringify({ stored: true }),
    })

    let handle = null
    const guests = []
    try {
        handle = await startBackend(platform)
        assert.equal(autobase.writable, true, 'owner node is writable and can accept candidates')

        const code = createInvite()
        assert.ok(code, 'the owner can mint an invite')

        // First guest consumes the single-use code.
        const first = presentInvite(new Hyperswarm({ bootstrap: testnet.bootstrap }), code)
        guests.push(first)
        const firstOutcome = await first.outcome
        assert.equal(firstOutcome.kind, 'paired', 'the first guest pairs normally')

        // Second guest presents the SAME code — the realistic case, since a code
        // gets forwarded in a group chat. The old code path answered with
        // silence; it must now say the code was used.
        const second = presentInvite(new Hyperswarm({ bootstrap: testnet.bootstrap }), code)
        guests.push(second)
        const secondOutcome = await second.outcome

        assert.notEqual(
            secondOutcome.kind,
            'no-answer',
            'REGRESSION: the host went silent — a refusal is being swallowed again',
        )
        assert.equal(secondOutcome.kind, 'refused')
        assert.equal(secondOutcome.code, 'INVITE_USED', 'and the guest can tell the user WHY')
    } finally {
        for (const guest of guests) {
            try { await guest.pairing.close() } catch (_) {}
            try { await guest.pairing.swarm.destroy() } catch (_) {}
        }
        // startBackend returns { paths, rpc, shutdown, disposeTeardown } — calling
        // a `teardown()` that does not exist left the storage lease held and the
        // next test fenced the previous backend instead of starting clean.
        try { await handle?.shutdown?.() } catch (_) {}
        try { handle?.disposeTeardown?.() } catch (_) {}
        try { await testnet.destroy() } catch (_) {}
        try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch (_) {}
    }
})

test('every code the owner mints stays usable alongside the others', { timeout: 180_000 }, async (t) => {
    // The scalar-invite bug: minting a code for the second friend silently
    // overwrote the first friend's, and the dead code then failed the host's id
    // match with no reply at all. "A fresh code per friend" was the exact thing
    // the owner did on 2026-08-26, and it was the worst possible move.
    const testnet = await createTestnet(3)
    const baseDir = mkdir()
    const platform = createNodePlatform({
        argv: [baseDir, '', '', ''],
        storageNamespace: 'multiinvitetest',
        bootstrap: testnet.bootstrap,
        leaseTtlMs: 60000,
        reply: () => JSON.stringify({ stored: true }),
    })

    let handle = null
    const guests = []
    try {
        handle = await startBackend(platform)

        const codeA = createInvite({ fresh: true })
        const codeB = createInvite({ fresh: true })
        assert.notEqual(codeA, codeB, 'a fresh mint really is a different code')

        // Redeem the OLDER one. Under the scalar invite this was already dead.
        const guestA = presentInvite(new Hyperswarm({ bootstrap: testnet.bootstrap }), codeA)
        guests.push(guestA)
        assert.equal(
            (await guestA.outcome).kind,
            'paired',
            'REGRESSION: minting a second code killed the first friend\'s code',
        )

        const guestB = presentInvite(new Hyperswarm({ bootstrap: testnet.bootstrap }), codeB)
        guests.push(guestB)
        assert.equal((await guestB.outcome).kind, 'paired', 'and the second code still works too')
    } finally {
        for (const guest of guests) {
            try { await guest.pairing.close() } catch (_) {}
            try { await guest.pairing.swarm.destroy() } catch (_) {}
        }
        // startBackend returns { paths, rpc, shutdown, disposeTeardown } — calling
        // a `teardown()` that does not exist left the storage lease held and the
        // next test fenced the previous backend instead of starting clean.
        try { await handle?.shutdown?.() } catch (_) {}
        try { handle?.disposeTeardown?.() } catch (_) {}
        try { await testnet.destroy() } catch (_) {}
        try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch (_) {}
    }
})
