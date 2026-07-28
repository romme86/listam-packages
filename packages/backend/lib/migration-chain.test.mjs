// Phase 15: the cumulative-migration chain on ONE base. A base forged in the
// pre-hardening prototype shape — bare text-keyed ops, legacy view entries
// without ids, plaintext key files, no membership records, no epochs — is
// opened by the current backend, which must stack every migration the
// hardening phases introduced:
//
//   M1  id-backfill        legacy items get deterministic legacy ids
//   C3  owner adoption     the local writer becomes the signed owner, once
//   C1/4 epoch bootstrap   epoch 1 exists; new ops are epoch-encrypted
//   M5/2 secret migration  plaintext key files move into the secret store
//                          and are deleted
//
// A restart then proves the stack is idempotent: same items, same ids, same
// owner (no re-bootstrap), same epoch, keys served from the secret store.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Autobase from 'autobase'
import createTestnet from 'hyperdht/testnet.js'
import { startBackend, createNodePlatform } from '../index.mjs'
import { createBackendChannel } from '@listam/client'
import {
    createFileSecretStore,
    prepareBackendSecrets,
    persistBackendSecretRequest,
    secretStoreKey,
} from '@listam/secrets'
import { legacyItemId } from '@listam/domain/list-reducer'
import { isLabelItem } from '@listam/domain'
import { RPC_ADD, RPC_GET_MEMBERS, RPC_REQUEST_SYNC } from '@listam/protocol'

// The prototype's apply: view entries were the bare item objects, keyed by
// text downstream — exactly what the M1 finding described.
async function forgeLegacyBase(baseDir) {
    const store = new Corestore(join(baseDir, 'lista-local'))
    await store.ready()
    const base = new Autobase(store, null, {
        apply: async (nodes, view) => {
            for (const { value } of nodes) {
                if (value?.type === 'add') await view.append({ ...value.value })
            }
        },
        open: (viewStore) => viewStore.get({ name: 'test', valueEncoding: 'json' }),
        valueEncoding: 'json',
        encrypt: true,
    })
    await base.ready()
    await base.append({ type: 'add', value: { text: 'Legacy milk', isDone: false, timeOfCompletion: 0 } })
    await base.append({ type: 'add', value: { text: 'Legacy bread', isDone: true, timeOfCompletion: 123 } })
    await base.update()
    const baseKeyHex = base.key.toString('hex')
    const encryptionKeyHex = base.encryptionKey.toString('hex')
    await base.close()
    await store.close()

    // The legacy plaintext key files, exactly where the current loader looks.
    writeFileSync(join(baseDir, 'lista-autobase-key.txt'), baseKeyHex)
    writeFileSync(join(baseDir, 'lista-encryption-key.txt'), encryptionKeyHex)
    return { baseKeyHex, encryptionKeyHex }
}

// Boot the current backend in-process over an injectable secret store,
// capturing list and roster projections from the decoded client events.
async function bootCurrentBackend(baseDir, secretStore, bootstrap) {
    const prepared = await prepareBackendSecrets({ secureStore: secretStore })
    const channel = createBackendChannel()
    const seen = { items: [], roster: null }
    channel.client.onEvent((event) => {
        if (event.type === 'persist-secret') {
            persistBackendSecretRequest(event.payload, { secureStore: secretStore })
                .then((result) => event.reply(JSON.stringify({ stored: result.mode === 'secure-store', mode: result.mode })))
                .catch(() => event.reply(JSON.stringify({ stored: false })))
            return
        }
        if (event.type === 'sync-list') seen.items = Array.isArray(event.items) ? event.items : []
        if (event.type === 'add-from-backend') seen.items = [event.item, ...seen.items.filter((i) => i.id !== event.item.id)]
        if (event.type === 'message' && event.payload?.type === 'membership-roster') seen.roster = event.payload.roster
    })

    const platform = createNodePlatform({
        argv: [baseDir, '', '', JSON.stringify(prepared.backendPayload)],
        bootstrap,
    })
    platform.createRpc = channel.platform.createRpc
    const backend = await startBackend(platform)
    return { backend, channel, seen, mode: prepared.mode }
}

test('cumulative migration chain: legacy base gains ids, owner, epoch, and secret-store keys — idempotently', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const baseDir = mkdtempSync(join(tmpdir(), 'listam-chain-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(baseDir, { recursive: true, force: true })
    })

    const { baseKeyHex, encryptionKeyHex } = await forgeLegacyBase(baseDir)
    const secretStore = createFileSecretStore({ fs, path: join(baseDir, 'chain-secrets.json') })

    // --- first boot on the legacy base: the whole chain runs ----------------
    const first = await bootCurrentBackend(baseDir, secretStore, testnet.bootstrap)

    // M1: legacy text-only entries got deterministic legacy ids, state intact.
    const milk = first.seen.items.find((item) => item.text === 'Legacy milk')
    const bread = first.seen.items.find((item) => item.text === 'Legacy bread')
    assert.ok(milk && bread, 'legacy items survive the reopen')
    assert.equal(milk.id, legacyItemId('Legacy milk'), 'ids backfill deterministically from text')
    assert.equal(bread.id, legacyItemId('Legacy bread'))
    assert.equal(bread.isDone, true, 'done state survives the id backfill')

    // C3/C1: the local writer adopted owner authority and epoch 1 exists.
    await first.channel.client.send(RPC_GET_MEMBERS)
    assert.ok(first.seen.roster, 'roster broadcast after owner adoption')
    assert.equal(first.seen.roster.canAdminister, true, 'this device adopted owner authority')
    assert.equal(first.seen.roster.currentEpoch, 1, 'epoch 1 bootstrapped on the legacy base')
    const ownerWriterKey = first.seen.roster.ownerWriterKey
    assert.match(ownerWriterKey, /^[0-9a-f]{64}$/)

    // M5/Phase 2: plaintext key files migrated into the secret store and gone.
    assert.equal(existsSync(join(baseDir, 'lista-autobase-key.txt')), false, 'plaintext autobase key retired')
    assert.equal(existsSync(join(baseDir, 'lista-encryption-key.txt')), false, 'plaintext encryption key retired')
    assert.equal(await secretStore.getItem(secretStoreKey('autobaseKey')), baseKeyHex, 'autobase key lives in the secret store')
    assert.equal(await secretStore.getItem(secretStoreKey('encryptionKey')), encryptionKeyHex, 'encryption key lives in the secret store')
    assert.ok(await secretStore.getItem(secretStoreKey('ownerAuthorityKey')), 'owner authority key born in the secret store')
    assert.ok(await secretStore.getItem(secretStoreKey('epochKey')), 'epoch key born in the secret store')

    // Phase 4: new writes land on the migrated base (epoch-encrypted path).
    await first.channel.client.send(RPC_ADD, { text: 'Modern item' })
    await first.channel.client.send(RPC_REQUEST_SYNC)
    const modern = first.seen.items.find((item) => item.text === 'Modern item')
    assert.ok(modern, 'a new item lands on the migrated base')
    assert.notEqual(modern.id, legacyItemId('Modern item'), 'new items carry generated ids, not legacy backfill')

    await first.backend.shutdown()

    // --- second boot: the chain is idempotent --------------------------------
    const second = await bootCurrentBackend(baseDir, secretStore, testnet.bootstrap)
    await second.channel.client.send(RPC_REQUEST_SYNC)
    await second.channel.client.send(RPC_GET_MEMBERS)

    const milkAfter = second.seen.items.find((item) => item.id === legacyItemId('Legacy milk'))
    const breadAfter = second.seen.items.find((item) => item.id === legacyItemId('Legacy bread'))
    const modernAfter = second.seen.items.find((item) => item.id === modern.id)
    assert.ok(milkAfter && breadAfter && modernAfter, 'all items rebuild with identical ids after restart')
    assert.equal(breadAfter.isDone, true)
    // Count only real list content: the backend also self-publishes a synced
    // presence/heartbeat meta-item (hidden from lists via isLabelItem), so the raw
    // item set carries one extra entry that is not a duplicate.
    assert.equal(second.seen.items.filter((item) => !isLabelItem(item)).length, 3, 'no duplicates from a re-run migration')

    assert.equal(second.seen.roster.ownerWriterKey, ownerWriterKey, 'owner adopted exactly once, not re-bootstrapped')
    assert.equal(second.seen.roster.currentEpoch, 1, 'epoch did not advance on restart')
    assert.equal(existsSync(join(baseDir, 'lista-autobase-key.txt')), false, 'plaintext keys stay retired')
    assert.equal(await secretStore.getItem(secretStoreKey('autobaseKey')), baseKeyHex, 'keys served from the secret store on restart')

    await second.backend.shutdown()
})
