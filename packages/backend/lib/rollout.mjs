// Flags for changes to what apply() ADMITS.
//
// A change to apply's admit/refuse verdict is a CONSENSUS change: if an upgraded
// peer keeps an operation an older peer drops, the two views diverge and never
// reconverge. That is the same hazard the board/kanban rename is gated on ("write
// stays 'kanban' until the whole mesh ships dual-read, else apply() forks").
//
// So a verdict change lands in two releases, not one:
//   1. ship the code with its flag OFF — behaviour is byte-identical, and every
//      peer gains the ability to understand the new rule;
//   2. flip the flag in a later release, once the mesh is known to be on a build
//      from step 1.
//
// Flipping one of these is a deliberate release decision. It is not a config
// knob for users, and it must never be flipped per-device: a mesh where some
// peers have it on and some have it off is exactly the fork it exists to
// prevent.
const FLAGS = {
    // apply's board rigor gate stops retroactively invalidating tickets that
    // were legal when they were written — it validates only tickets created at
    // or after the moment rigor was turned on.
    //
    // Without it, turning rigor ON makes every pre-existing sparse ticket
    // droppable, and WHICH peer drops it depends on linearization order, so a
    // ticket can be announced and then discarded (apply-discard-reorder.test.mjs).
    //
    // FLIPPED 2026-07-27, one release after the code landed (dd6a169). Peers on
    // an older build still drop those tickets, so the two disagree until every
    // peer is updated — that window is the cost of the flip, and it closes as the
    // last peer deploys.
    rigorNotRetroactive: true,

    // Board adds carry `boardConfigSeq`: which board-config the writer had
    // actually seen when it wrote the ticket. apply honours the stamp whenever
    // one is present (no flag needed for that — it is inert until stamps exist),
    // so this flag gates the WRITE side, which is the consensus-critical half.
    //
    // It closes what the timestamp rule cannot: a writer that had not yet seen
    // the rigor-on config still has a wall clock past the transition, and no
    // comparison of timestamps can tell that apart from a writer that had seen
    // it. What the writer knew is only knowable to the writer.
    //
    // Flip only once every peer runs a build that reads the stamp; until then an
    // older peer ignores it and applies its own rule to the same ticket.
    stampBoardConfigOnWrite: false,
}

const flags = { ...FLAGS }

export function rolloutEnabled (name) {
    return flags[name] === true
}

// Tests drive this to exercise the post-flip behaviour; a release flips the
// default in FLAGS above rather than calling this.
export function setRolloutFlag (name, value) {
    if (!(name in FLAGS)) throw new Error(`Unknown rollout flag: ${name}`)
    flags[name] = value === true
}

export function resetRolloutFlags () {
    Object.assign(flags, FLAGS)
}

export function rolloutFlags () {
    return { ...flags }
}
