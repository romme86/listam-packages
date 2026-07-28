import test from 'node:test'
import assert from 'node:assert/strict'
import { rolloutEnabled, setRolloutFlag, resetRolloutFlags, rolloutFlags } from './rollout.mjs'

// The shipped state of every flag, written out rather than derived.
//
// Flipping one changes what apply() ADMITS across the mesh, so it must never be
// a quiet edit: changing a default here forces this literal to change too, and
// that diff is the record of a deliberate release decision.
const SHIPPED = {
    // Flipped 2026-07-27, one release after the code landed (dd6a169).
    rigorNotRetroactive: true,
    // Ships off: writers must not start stamping until every peer reads stamps.
    stampBoardConfigOnWrite: false,
    // Ships off: an upgraded peer would keep old-epoch ops an older peer drops.
    acceptHeldEpochOps: false,
}

test('the shipped flags are exactly what this test declares', () => {
    resetRolloutFlags()
    assert.deepEqual(rolloutFlags(), SHIPPED)
})

test('a flag can be turned on, turned off, and reset to its shipped default', () => {
    resetRolloutFlags()
    setRolloutFlag('rigorNotRetroactive', false)
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false)
    setRolloutFlag('rigorNotRetroactive', true)
    assert.equal(rolloutEnabled('rigorNotRetroactive'), true)
    resetRolloutFlags()
    assert.equal(rolloutEnabled('rigorNotRetroactive'), SHIPPED.rigorNotRetroactive)
})

test('only an exact true turns a flag on', () => {
    resetRolloutFlags()
    setRolloutFlag('rigorNotRetroactive', 'yes')
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false, 'a truthy string must not enable a consensus change')
    resetRolloutFlags()
})

test('an unknown flag throws rather than silently doing nothing', () => {
    // A typo that silently no-ops would look like the flag was set, and the
    // difference would only show up as a mesh fork.
    assert.throws(() => setRolloutFlag('rigorNotRetroactiv', true), /Unknown rollout flag/)
})

test('rolloutEnabled is false for names that do not exist', () => {
    assert.equal(rolloutEnabled('nope'), false)
    assert.equal(rolloutEnabled(undefined), false)
})

test('rolloutFlags returns a copy, so callers cannot flip a flag by mutating it', () => {
    resetRolloutFlags()
    const flags = rolloutFlags()
    flags.rigorNotRetroactive = !SHIPPED.rigorNotRetroactive
    assert.equal(rolloutEnabled('rigorNotRetroactive'), SHIPPED.rigorNotRetroactive)
})
