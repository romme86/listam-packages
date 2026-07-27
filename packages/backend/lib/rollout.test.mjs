import test from 'node:test'
import assert from 'node:assert/strict'
import { rolloutEnabled, setRolloutFlag, resetRolloutFlags, rolloutFlags } from './rollout.mjs'

test('every flag ships OFF, so introducing one cannot change what apply admits', () => {
    resetRolloutFlags()
    for (const [name, value] of Object.entries(rolloutFlags())) {
        assert.equal(value, false, `${name} must default to off — flipping it is a separate release`)
    }
})

test('a flag can be turned on and reset', () => {
    resetRolloutFlags()
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false)
    setRolloutFlag('rigorNotRetroactive', true)
    assert.equal(rolloutEnabled('rigorNotRetroactive'), true)
    resetRolloutFlags()
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false)
})

test('only an exact true turns a flag on', () => {
    resetRolloutFlags()
    setRolloutFlag('rigorNotRetroactive', 'yes')
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false, 'a truthy string must not enable a consensus change')
    resetRolloutFlags()
})

test('an unknown flag throws rather than silently doing nothing', () => {
    // A typo that silently no-ops would look like the flag was set, and the
    // difference only shows up as a mesh fork.
    assert.throws(() => setRolloutFlag('rigorNotRetroactiv', true), /Unknown rollout flag/)
})

test('rolloutEnabled is false for names that do not exist', () => {
    assert.equal(rolloutEnabled('nope'), false)
    assert.equal(rolloutEnabled(undefined), false)
})

test('rolloutFlags returns a copy, so callers cannot flip a flag by mutating it', () => {
    resetRolloutFlags()
    const flags = rolloutFlags()
    flags.rigorNotRetroactive = true
    assert.equal(rolloutEnabled('rigorNotRetroactive'), false)
})
