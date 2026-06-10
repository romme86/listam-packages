// Consensus-layer writer removal (Phase 4, finding C1 hardening).
//
// Member removal has two enforcement layers: the epoch re-key (the removed
// device cannot decrypt new content) and the Autobase writer removal (the
// removed device cannot append). The re-key always succeeds locally, but the
// Autobase removal can fail — the runtime may not support removeWriter, or the
// writer may not be removable — and if it does, the removed member may retain
// append capability. That must be surfaced, never swallowed, so the owner knows
// the removal is only partially enforced and can intervene.
//
// Returns { removed: boolean, reason } so the caller can log/notify accordingly.
export async function removeWriterAtConsensus({ host, writerKey, logger }) {
    if (!host || typeof host.removeWriter !== 'function') {
        logger.log('[ERROR] Cannot remove writer: this runtime does not support Autobase writer removal. The removed member may still be able to append; manual intervention required.')
        return { removed: false, reason: 'unsupported' }
    }

    if (typeof host.removeable === 'function' && host.removeable(writerKey) === false) {
        logger.log('[ERROR] Membership removal accepted but Autobase reports the writer is not removable; the removed member may still be able to append.')
        return { removed: false, reason: 'not-removable' }
    }

    try {
        await host.removeWriter(writerKey)
        return { removed: true, reason: null }
    } catch (err) {
        logger.log('[ERROR] Failed to remove writer at the Autobase layer; the removed member may still be able to append:', err)
        return { removed: false, reason: 'error' }
    }
}
