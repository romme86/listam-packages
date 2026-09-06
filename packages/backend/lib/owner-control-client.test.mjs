// Wrapper for the mobile owner-control client hyperdht scenario. The scenario
// runs as a plain child process (owner-control-client.scenario.mjs) so
// hyperdht's post-teardown reset noise cannot fail the run after the
// assertions have passed; this wrapper asserts a clean exit plus checkpoints.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { createOwnerControlClient } from './owner-control-client.mjs'

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), 'owner-control-client.scenario.mjs')
const EXPECTED_MARKS = ['OCCLIENT paired', 'OCCLIENT scoped-commands', 'OCCLIENT stable-identity', 'OCCLIENT complete']

test('mobile owner-control client pairs and commands over hyperdht', { timeout: 180_000 }, async () => {
    const proc = spawn(process.execPath, [SCENARIO], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, `scenario failed (exit ${code})\nstdout: ${stdout.slice(-1000)}\nstderr: ${stderr.slice(-2000)}`)
    for (const markLine of EXPECTED_MARKS) {
        assert.ok(stdout.includes(markLine), `missing checkpoint: ${markLine}`)
    }
})

test('an owner-control dial timeout destroys its socket and registers its transport for sleep', async () => {
    const socket = new EventEmitter()
    let destroyed = 0, registered
    socket.destroy = () => { destroyed++; socket.emit('close') }
    const dht = { connect: () => socket, async destroy() {} }
    const client = createOwnerControlClient({
        createDht: () => dht, registerNetwork: (transport) => { registered = transport },
        loadControlSeed: async () => '11'.repeat(32), saveControlSeed: async () => true,
        requestTimeoutMs: 10,
    })
    await assert.rejects(client.command('22'.repeat(32), 'status', {}), /control connection timed out/)
    assert.equal(registered, dht)
    assert.equal(destroyed, 1)
    assert.equal(socket.listenerCount('open'), 0)
    assert.equal(socket.listenerCount('close'), 0)
    await client.close()
})
