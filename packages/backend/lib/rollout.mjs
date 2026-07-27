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
    rigorNotRetroactive: false,
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
