import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerAuthorityKeyPair, ownerAuthorityPublicKeyHex } from './membership.mjs'
import {
    deriveOwnerAuthorityFromSeed,
    formatOwnerRecoveryCode,
    ownerRecoveryCodeFromKeyPair,
    ownerRecoverySeedFromKeyPair,
    parseOwnerRecoveryCode,
    recoverOwnerAuthorityFromCode,
} from './owner-recovery.mjs'

test('a recovery code round-trips back to the exact owner authority keypair', () => {
    const owner = createOwnerAuthorityKeyPair()
    const code = ownerRecoveryCodeFromKeyPair(owner)
    assert.equal(typeof code, 'string')
    assert.ok(code.length > 0)

    const seed = parseOwnerRecoveryCode(code)
    assert.equal(seed.length, 32)

    const recovered = deriveOwnerAuthorityFromSeed(seed)
    assert.equal(recovered.publicKey.toString('hex'), owner.publicKey.toString('hex'))
    assert.equal(recovered.secretKey.toString('hex'), owner.secretKey.toString('hex'))
})

test('recovery verifies the code against the base-recorded owner public key', () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerPublicKeyHex = ownerAuthorityPublicKeyHex(owner)
    const code = ownerRecoveryCodeFromKeyPair(owner)

    const recovered = recoverOwnerAuthorityFromCode(code, ownerPublicKeyHex)
    assert.equal(recovered.secretKey.toString('hex'), owner.secretKey.toString('hex'))
})

test('a recovery code for a different owner is rejected', () => {
    const owner = createOwnerAuthorityKeyPair()
    const otherOwner = createOwnerAuthorityKeyPair()
    const code = ownerRecoveryCodeFromKeyPair(otherOwner)

    assert.equal(recoverOwnerAuthorityFromCode(code, ownerAuthorityPublicKeyHex(owner)), null)
})

test('malformed recovery codes are rejected, not thrown', () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerPublicKeyHex = ownerAuthorityPublicKeyHex(owner)

    assert.equal(parseOwnerRecoveryCode(''), null)
    assert.equal(parseOwnerRecoveryCode('   '), null)
    assert.equal(parseOwnerRecoveryCode(null), null)
    assert.equal(parseOwnerRecoveryCode('not a real code !!!'), null)
    assert.equal(recoverOwnerAuthorityFromCode('garbage', ownerPublicKeyHex), null)
    assert.equal(recoverOwnerAuthorityFromCode(ownerRecoveryCodeFromKeyPair(owner), 'tooshort'), null)
})

test('whitespace in a pasted recovery code is tolerated', () => {
    const owner = createOwnerAuthorityKeyPair()
    const code = ownerRecoveryCodeFromKeyPair(owner)
    const spaced = `  ${code.slice(0, 5)} ${code.slice(5)}\n`

    const recovered = recoverOwnerAuthorityFromCode(spaced, ownerAuthorityPublicKeyHex(owner))
    assert.equal(recovered.secretKey.toString('hex'), owner.secretKey.toString('hex'))
})

test('the recovery seed is the first half of the secret and not the whole secret', () => {
    const owner = createOwnerAuthorityKeyPair()
    const seed = ownerRecoverySeedFromKeyPair(owner)
    assert.equal(seed.toString('hex'), owner.secretKey.subarray(0, 32).toString('hex'))
    assert.notEqual(formatOwnerRecoveryCode(seed), owner.secretKey.toString('hex'))
})
