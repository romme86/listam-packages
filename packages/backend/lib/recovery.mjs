// Corruption recovery for the Autobase/Corestore storage root (finding M4).
//
// The old behavior on a corrupt base was to delete the key material and the
// entire storage root, then silently recreate a fresh base — destroying the
// user's only copy on a parse error. These helpers replace that with:
//
//   detect   — classify the ready() failure as the known corruption shape;
//   plan     — gate what may happen next on an explicit recovery policy
//              ('interactive' apps may offer a destructive reset after user
//              confirmation; 'refuse-destructive' nodes, e.g. headless
//              storage helpers, never get a destructive option at all);
//   quarantine — move the suspect root aside intact (rename, not delete)
//              and leave a manifest with redacted key fingerprints so the
//              archived ciphertext can be matched to its keys later.
//
// Nothing in this module deletes data. The only destructive step a caller
// may take after quarantine is starting a fresh base, and plan() only allows
// that for an interactive owner-confirmed request while recovery is pending.

export const RECOVERY_POLICIES = Object.freeze(['interactive', 'refuse-destructive'])
export const RECOVERY_ACTIONS = Object.freeze(['retry', 'reset'])

const CORRUPTION_SIGNATURES = [
    "reading 'signers'",
    'autobase/lib/store.js',
]

export function normalizeRecoveryPolicy(policy) {
    return RECOVERY_POLICIES.includes(policy) ? policy : 'refuse-destructive'
}

export function isCorruptionSignature(error) {
    const message = String(error?.stack || error?.message || error || '')
    return CORRUPTION_SIGNATURES.some((signature) => message.includes(signature))
}

export function describeCorruption(error) {
    return {
        reason: 'storage-corrupt',
        signature: isCorruptionSignature(error) ? 'autobase-boot' : 'unknown',
        message: String(error?.message || error || 'Autobase storage failed to open'),
    }
}

// Decide whether a requested recovery action may proceed. Destructive
// recovery requires all three: a pending corruption (never reset a healthy
// base), an interactive policy (headless refuses), and the explicit 'reset'
// action (which the UI only sends after user confirmation).
export function planRecoveryAction({ action, policy, pending }) {
    if (!RECOVERY_ACTIONS.includes(action)) {
        return { ok: false, reason: 'unknown-action' }
    }
    if (!pending) {
        return { ok: false, reason: 'no-recovery-pending' }
    }
    if (action === 'reset' && normalizeRecoveryPolicy(policy) !== 'interactive') {
        return { ok: false, reason: 'destructive-recovery-refused' }
    }
    return { ok: true, action }
}

// Move the suspect storage root aside intact and drop a manifest beside the
// archived data. The manifest carries only redacted fingerprints — never raw
// keys or list content — so recovery logs and the archive itself stay within
// the redaction rules.
export function quarantineStorageRoot(fs, storagePath, { reason = 'storage-corrupt', fingerprints = {}, now = Date.now } = {}) {
    if (!fs) throw new Error('A filesystem adapter is required to quarantine storage')
    if (!storagePath) return { ok: false, reason: 'missing-path' }

    let exists = false
    try {
        exists = fs.existsSync(storagePath)
    } catch {
        exists = false
    }
    if (!exists) return { ok: false, reason: 'missing' }

    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    let quarantinePath = `${storagePath}.quarantine-${stamp}`
    for (let suffix = 1; fs.existsSync(quarantinePath); suffix++) {
        quarantinePath = `${storagePath}.quarantine-${stamp}-${suffix}`
    }

    try {
        fs.renameSync(storagePath, quarantinePath)
    } catch (error) {
        return { ok: false, reason: 'rename-failed', error }
    }

    try {
        fs.writeFileSync(`${quarantinePath}/RECOVERY.json`, JSON.stringify({
            version: 1,
            quarantinedAt: new Date(now()).toISOString(),
            reason,
            fingerprints,
        }))
    } catch {
        // The manifest is best-effort metadata; the archived data itself is
        // already safe once the rename succeeded.
    }

    return { ok: true, quarantinePath }
}
