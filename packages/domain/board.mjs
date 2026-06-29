// Pure board domain logic shared by every Listam client and the backend.
//
// A board ticket is an ordinary list item whose `listType` is a board type
// (see isBoardType) carrying a few extra optional fields. Nothing here touches
// Autobase, the DOM, or any I/O; the same functions run write-side in the
// backend (to freeze the objective facts at the source writer) and read-side in
// any frontend (to render).

// Canonical board list-type value. Frontends normalize any board list to this.
export const BOARD_LIST_TYPE = 'board'
// Pre-rename wire value. Still accepted on read forever, for interop with peers
// (and the frozen mobile backend bundle) that predate the rename.
export const LEGACY_BOARD_LIST_TYPE = 'kanban'
// Value WRITTEN for new boards/tickets. Deliberately kept at the legacy wire
// value: flipping it to BOARD_LIST_TYPE before every peer — including the
// pre-bundled mobile backend — ships the dual-read isBoardType() below would
// diverge apply() across peers (some would run the rigor gate on a 'board'
// ticket, some would not). Flip this to BOARD_LIST_TYPE only once the whole
// mesh recognizes both values.
export const BOARD_WRITE_TYPE = LEGACY_BOARD_LIST_TYPE
export const BOARD_CONFIG_VERSION = 1

export const BOARD_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done']

export const TIMELINESS = {
    ON_TIME: 'on_time',
    OVERTIME: 'overtime',
    UNDERTIME: 'undertime',
}

// On reaching Done: delta = (actual - estimate) / estimate.
//   delta > +10%  -> overtime  (not done in time)
//   delta < -10%  -> undertime (overestimated)
//   otherwise     -> on time
export const OVERTIME_THRESHOLD = 0.10
export const UNDERTIME_THRESHOLD = -0.10

const HOUR_MS = 3600000
// A single in-progress slice longer than this is treated as clock garbage and
// clamped — the writer that performs the exit transition mixes its own wall
// clock with another writer's `inProgressSince`, so unbounded skew is possible.
const DEFAULT_MAX_SLICE_MS = 90 * 24 * HOUR_MS

export const DEFAULT_BOARD_CONFIG = {
    version: BOARD_CONFIG_VERSION,
    rigorOn: true,
    states: [
        { id: 'todo', name: 'To do', color: '#888780', wipLimit: 0, isDone: false },
        { id: 'in_progress', name: 'In progress', color: '#378ADD', wipLimit: 0, isDone: false },
        { id: 'blocked', name: 'Blocked', color: '#EF9F27', wipLimit: 0, isDone: false },
        { id: 'review', name: 'Review', color: '#7F77DD', wipLimit: 0, isDone: false },
        { id: 'done', name: 'Done', color: '#1D9E75', wipLimit: 0, isDone: true },
    ],
    properties: [
        { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'medium', 'high', 'urgent'] },
        { key: 'assignee', label: 'Assignee', kind: 'person' },
        { key: 'dueAt', label: 'Due date', kind: 'date' },
        { key: 'estimatedHours', label: 'Estimate', kind: 'number' },
        { key: 'estimatedComplexity', label: 'Complexity', kind: 'number' },
    ],
    rules: [
        { id: 'rigor-required', kind: 'rigor-required', params: {}, enforce: 'block', enabled: true },
        { id: 'done-gate', kind: 'done-gate', params: {}, enforce: 'block', enabled: true },
    ],
    automations: [
        { id: 'freeze-timeliness', trigger: 'status:done', actions: ['freeze-timeliness'], enabled: true },
    ],
}

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp (value, lo, hi) {
    return Math.min(hi, Math.max(lo, value))
}

function round2 (value) {
    return Math.round(value * 100) / 100
}

export function msToHours (ms) {
    return numberOr(ms, 0) / HOUR_MS
}

// True for both the canonical 'board' value and the legacy 'kanban' value, so
// reads converge across upgraded and un-upgraded peers.
export function isBoardType (type) {
    return type === BOARD_LIST_TYPE || type === LEGACY_BOARD_LIST_TYPE
}

export function isBoardTicket (item) {
    return !!item && typeof item === 'object' && isBoardType(item.listType)
}

export function isBoardStatus (status) {
    return BOARD_STATUSES.includes(status)
}

// Statuses that count as "done" for a given board config (custom states may
// flag their own done column). Falls back to the literal 'done'.
export function doneStatusesOf (config) {
    const states = config && Array.isArray(config.states) ? config.states : null
    if (!states) return ['done']
    const done = states.filter((s) => s && s.isDone).map((s) => s.id)
    return done.length ? done : ['done']
}

// Merge a partial config onto the defaults so callers always get a complete,
// well-shaped object (used by the backend reducer and every frontend).
export function normalizeBoardConfig (partial) {
    const base = DEFAULT_BOARD_CONFIG
    if (!partial || typeof partial !== 'object') return { ...base }
    return {
        version: numberOr(partial.version, base.version),
        rigorOn: typeof partial.rigorOn === 'boolean' ? partial.rigorOn : base.rigorOn,
        states: Array.isArray(partial.states) && partial.states.length ? partial.states : base.states,
        properties: Array.isArray(partial.properties) ? partial.properties : base.properties,
        rules: Array.isArray(partial.rules) ? partial.rules : base.rules,
        automations: Array.isArray(partial.automations) ? partial.automations : base.automations,
    }
}

// Required-field gate for ticket creation. Only enforced when rigor mode is on,
// and (by caller convention) only on `add` — never on later updates, so status
// changes of legacy/grandfathered tickets are never rejected.
export function validateTicketDraft (item, config = DEFAULT_BOARD_CONFIG) {
    const missing = []
    if (!config || !config.rigorOn) return { ok: true, missing }
    const it = item || {}

    if (typeof it.description !== 'string' || !it.description.trim()) missing.push('description')

    const checklist = Array.isArray(it.checklist) ? it.checklist : []
    const hasTask = checklist.some((t) => t && typeof t.text === 'string' && t.text.trim())
    if (!hasTask) missing.push('checklist')

    if (!(numberOr(it.estimatedHours, 0) > 0)) missing.push('hours')

    const complexity = numberOr(it.estimatedComplexity, 0)
    if (!(complexity >= 1 && complexity <= 100)) missing.push('complexity')

    return { ok: missing.length === 0, missing }
}

export function computeTimeliness (actualHours, estimatedHours) {
    if (!(numberOr(estimatedHours, 0) > 0)) return null
    const delta = (actualHours - estimatedHours) / estimatedHours
    if (delta > OVERTIME_THRESHOLD) return TIMELINESS.OVERTIME
    if (delta < UNDERTIME_THRESHOLD) return TIMELINESS.UNDERTIME
    return TIMELINESS.ON_TIME
}

// Given the stored item and an incoming update, compute the time-tracking and
// timeliness fields. Called write-side in updateItem so the writer that owns the
// wall clock computes its own elapsed slice; the frozen result then propagates
// verbatim and every peer agrees.
//
// Returns a new merged item (does not mutate inputs).
export function applyStatusTransition (existing, incoming, now, opts = {}) {
    const {
        writerKey = null,
        maxSliceMs = DEFAULT_MAX_SLICE_MS,
        doneStatuses = ['done'],
        inProgressStatus = 'in_progress',
    } = opts

    const next = { ...incoming }
    const prevStatus = existing && existing.status != null ? existing.status : null
    const nextStatus = next.status != null ? next.status : (prevStatus != null ? prevStatus : 'todo')
    next.status = nextStatus

    // The accumulator and open-slice marker are authoritative on the stored item.
    let inProgressMs = numberOr(existing && existing.inProgressMs, numberOr(incoming.inProgressMs, 0))
    let inProgressSince = existing && typeof existing.inProgressSince === 'number' ? existing.inProgressSince : null

    const wasInProgress = prevStatus === inProgressStatus
    const isInProgress = nextStatus === inProgressStatus

    if (!wasInProgress && isInProgress) {
        inProgressSince = now
    } else if (wasInProgress && !isInProgress) {
        if (typeof inProgressSince === 'number') {
            inProgressMs += clamp(now - inProgressSince, 0, maxSliceMs)
        }
        inProgressSince = null
    }

    next.inProgressMs = inProgressMs
    next.inProgressSince = inProgressSince

    const wasDone = doneStatuses.includes(prevStatus)
    const isDone = doneStatuses.includes(nextStatus)
    next.isDone = isDone

    if (isDone && !wasDone) {
        const actualHours = msToHours(inProgressMs)
        const estimate = numberOr(next.estimatedHours, numberOr(existing && existing.estimatedHours, 0))
        next.actualInProgressHours = round2(actualHours)
        next.timeliness = computeTimeliness(actualHours, estimate)
        next.timeOfCompletion = now
        if (writerKey) next.completedBy = writerKey
    } else if (!isDone && wasDone) {
        // Reopen: drop the frozen verdict so a stale badge is never shown; a
        // later re-completion recomputes it.
        next.timeOfCompletion = 0
        next.timeliness = null
        next.actualInProgressHours = 0
        delete next.completedBy
    } else if (isDone && wasDone) {
        if (!(numberOr(next.timeOfCompletion, 0) > 0)) {
            next.timeOfCompletion = numberOr(existing && existing.timeOfCompletion, now)
        }
    }

    return next
}

// Per-user calibration. A user is more congruent the closer their average
// estimated complexity is to the share of their tickets that missed the estimate
// in either direction (overtime OR undertime). Volume-shrunk toward a neutral 50
// so a handful of completions can't produce an extreme score.
export function computeCongruency (tickets, opts = {}) {
    const shrinkK = numberOr(opts.shrinkK, 5)
    const groups = new Map()

    for (const t of (Array.isArray(tickets) ? tickets : [])) {
        if (!t || t.timeliness == null) continue
        const user = t.completedBy || t.createdBy || t.assignee || 'unassigned'
        if (!groups.has(user)) {
            groups.set(user, { user, count: 0, sumComplexity: 0, onTime: 0, over: 0, under: 0 })
        }
        const g = groups.get(user)
        g.count += 1
        g.sumComplexity += numberOr(t.estimatedComplexity, 0)
        if (t.timeliness === TIMELINESS.OVERTIME) g.over += 1
        else if (t.timeliness === TIMELINESS.UNDERTIME) g.under += 1
        else g.onTime += 1
    }

    const out = []
    for (const g of groups.values()) {
        const avgComplexity = g.count ? g.sumComplexity / g.count : 0
        const offEstimateRate = g.count ? (100 * (g.over + g.under)) / g.count : 0
        const onTimeRate = g.count ? (100 * g.onTime) / g.count : 0
        const gap = Math.abs(avgComplexity - offEstimateRate)
        const raw = 100 - gap
        const score = g.count ? Math.round(50 + (raw - 50) * (g.count / (g.count + shrinkK))) : 0
        let tendency = 'calibrated'
        if (g.over > g.under) tendency = 'underestimates'
        else if (g.under > g.over) tendency = 'overestimates'
        out.push({
            user: g.user,
            count: g.count,
            avgComplexity: Math.round(avgComplexity),
            offEstimateRate: Math.round(offEstimateRate),
            onTimeRate: Math.round(onTimeRate),
            onTime: g.onTime,
            over: g.over,
            under: g.under,
            gap: Math.round(gap),
            score,
            tendency,
        })
    }

    out.sort((a, b) => (b.count - a.count) || a.user.localeCompare(b.user))
    return out
}

// Guardrails evaluated before a transition is accepted. `block` rules forbid the
// move; `warn` rules surface a caution but allow it.
export function evaluateRules (config = DEFAULT_BOARD_CONFIG, nextItem = {}, prevItem = null, allItems = []) {
    const blocked = []
    const warnings = []
    const rules = config && Array.isArray(config.rules) ? config.rules : []
    const nextStatus = nextItem.status
    const movedStatus = !prevItem || prevItem.status !== nextStatus
    const list = Array.isArray(allItems) ? allItems : []

    for (const rule of rules) {
        if (!rule || rule.enabled === false) continue
        const sink = rule.enforce === 'warn' ? warnings : blocked
        const params = rule.params || {}

        switch (rule.kind) {
            case 'wip-limit': {
                const limit = numberOr(params.limit, 0)
                if (!params.status || !(limit > 0)) break
                if (nextStatus === params.status && movedStatus) {
                    const count = list.filter((i) => i && i.id !== nextItem.id && i.status === params.status).length
                    if (count + 1 > limit) sink.push({ rule: rule.id, kind: rule.kind, message: `wip-limit:${params.status}:${limit}` })
                }
                break
            }
            case 'required-owner': {
                const status = params.status || 'in_progress'
                if (nextStatus === status && !`${nextItem.assignee || ''}`.trim()) {
                    sink.push({ rule: rule.id, kind: rule.kind, message: 'required-owner' })
                }
                break
            }
            case 'done-gate': {
                if (nextStatus === 'done') {
                    const checklist = Array.isArray(nextItem.checklist) ? nextItem.checklist : []
                    const open = checklist.filter((t) => t && !t.done).length
                    if (open > 0) sink.push({ rule: rule.id, kind: rule.kind, message: `done-gate:${open}` })
                }
                break
            }
            case 'blocked-reason': {
                if (nextStatus === 'blocked' && !`${nextItem.blockedReason || ''}`.trim()) {
                    sink.push({ rule: rule.id, kind: rule.kind, message: 'blocked-reason' })
                }
                break
            }
            default:
                break
        }
    }

    return { ok: blocked.length === 0, blocked, warnings }
}

// ---------------------------------------------------------------------------
// Board presentation helpers (shared by every frontend). Pure: data → data, no
// DOM and no store. The desktop wrapped these in src/ticket.mjs; they live here
// so the mobile RN board reuses the exact same logic, and the desktop re-imports.
// ---------------------------------------------------------------------------

// Filter an item list down to board tickets (legacy + canonical wire value).
export function selectTickets (items) {
    return (Array.isArray(items) ? items : []).filter(isBoardTicket)
}

// Group tickets into board columns in the config's state order. Tickets with an
// unknown/missing status fall into the first column.
export function groupByStatus (items, config) {
    const cfg = normalizeBoardConfig(config)
    const states = cfg.states
    const firstId = states[0]?.id
    const byId = new Map(states.map((s) => [s.id, []]))
    for (const ticket of selectTickets(items)) {
        const status = byId.has(ticket.status) ? ticket.status : firstId
        if (byId.has(status)) byId.get(status).push(ticket)
    }
    return states.map((state) => ({ state, tickets: byId.get(state.id) || [] }))
}

// Everything a ticket card renders, including a live in-progress duration that
// extends an open timer to `now` (the stored inProgressMs only counts closed
// slices).
export function ticketBadges (item, now = Date.now()) {
    const checklist = Array.isArray(item?.checklist) ? item.checklist : []
    let inProgressMs = typeof item?.inProgressMs === 'number' ? item.inProgressMs : 0
    if (item?.status === 'in_progress' && typeof item?.inProgressSince === 'number') {
        inProgressMs += Math.max(0, now - item.inProgressSince)
    }
    return {
        priority: item?.priority || null,
        assignee: item?.assignee || item?.createdBy || null,
        dueAt: typeof item?.dueAt === 'number' ? item.dueAt : null,
        checklistDone: checklist.filter((t) => t && t.done).length,
        checklistTotal: checklist.length,
        inProgressMs,
        inProgressHours: msToHours(inProgressMs),
        estimatedHours: typeof item?.estimatedHours === 'number' ? item.estimatedHours : null,
        estimatedComplexity: typeof item?.estimatedComplexity === 'number' ? item.estimatedComplexity : null,
        timeliness: item?.timeliness || null,
        isDone: !!item?.isDone,
        running: item?.status === 'in_progress',
    }
}

// Build the single update payload a status change emits. Returns null for a
// no-op (same status). updatedAt is always bumped so the LWW reducer never drops
// the move; the backend computes the time/timeliness fields from this.
export function buildStatusChange (item, status, now = Date.now()) {
    if (!item || item.status === status) return null
    return { ...item, status, updatedAt: now }
}

// "4h 12m" / "37m" — compact in-progress / elapsed display.
export function formatDuration (ms) {
    const totalMin = Math.max(0, Math.round((typeof ms === 'number' ? ms : 0) / 60000))
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Percentage delta of actual vs estimate, signed, for the on-time/overtime badge
// label (e.g. "+28%", "-35%"). null when there is no estimate.
export function deltaPercent (actualHours, estimatedHours) {
    if (!(typeof estimatedHours === 'number' && estimatedHours > 0)) return null
    return Math.round(((actualHours - estimatedHours) / estimatedHours) * 100)
}

// ---------------------------------------------------------------------------
// Block-based ticket body. A ticket carries an optional
// `blocks: [{id, type, ...payload}]` array. Each block edits as raw text and
// renders formatted; the parse/serialize logic below is pure & unit-testable.
// Inline-markdown RENDERING is per-platform (desktop emits HTML, mobile RN), so
// it stays out of here.
// ---------------------------------------------------------------------------

// Order + i18n label (+ a desktop tabler icon hint) for the insert menu.
export const BLOCK_TYPES = [
    { type: 'heading', icon: 'heading', labelKey: 'ticket.block.type.heading' },
    { type: 'divider', icon: 'minus', labelKey: 'ticket.block.type.divider' },
    { type: 'markdown', icon: 'align-left', labelKey: 'ticket.block.type.markdown' },
    { type: 'checklist', icon: 'checklist', labelKey: 'ticket.block.type.checklist' },
    { type: 'numberedList', icon: 'list-numbers', labelKey: 'ticket.block.type.numberedList' },
    { type: 'links', icon: 'link', labelKey: 'ticket.block.type.links' },
    { type: 'image', icon: 'photo', labelKey: 'ticket.block.type.image' },
    { type: 'table', icon: 'table', labelKey: 'ticket.block.type.table' },
    { type: 'callout', icon: 'quote', labelKey: 'ticket.block.type.callout' },
    { type: 'code', icon: 'code', labelKey: 'ticket.block.type.code' },
]

const BLOCK_TYPE_SET = new Set(BLOCK_TYPES.map((b) => b.type))

export function isBlockType (type) {
    return BLOCK_TYPE_SET.has(type)
}

export function normalizeBlocks (blocks) {
    return (Array.isArray(blocks) ? blocks : []).filter((b) => b && isBlockType(b.type) && typeof b.id === 'string')
}

// A freshly-inserted, empty block of the given type.
export function createBlock (type, id) {
    const base = { id, type: isBlockType(type) ? type : 'markdown' }
    switch (base.type) {
        case 'heading': return { ...base, text: '', level: 2 }
        case 'divider': return { ...base }
        case 'checklist': return { ...base, items: [{ text: '', done: false }] }
        case 'numberedList': return { ...base, items: [{ text: '' }] }
        case 'links': return { ...base, links: [{ label: '', url: '' }] }
        case 'image': return { ...base, url: '', alt: '' }
        case 'table': return { ...base, rows: [['', ''], ['', '']] }
        case 'callout': return { ...base, text: '', tone: 'info' }
        case 'code': return { ...base, text: '', lang: '' }
        default: return { ...base, text: '' }
    }
}

// Serialize a block to the raw text shown in its edit field.
export function blockToText (block) {
    if (!block) return ''
    switch (block.type) {
        case 'checklist':
            return (block.items || []).map((it) => `[${it.done ? 'x' : ' '}] ${it.text || ''}`.trimEnd()).join('\n')
        case 'numberedList':
            return (block.items || []).map((it) => it.text || '').join('\n')
        case 'links':
            return (block.links || []).map((l) => `${l.label || ''} | ${l.url || ''}`.trim()).join('\n')
        case 'image':
            return [block.url || '', block.alt || ''].join('\n').replace(/\n$/, '')
        case 'table':
            return (block.rows || []).map((row) => (row || []).join(', ')).join('\n')
        default:
            return block.text || ''
    }
}

// Parse the raw field value back into a block payload patch (inverse of
// blockToText). Returns the fields to merge onto the block (never the id/type).
export function blockFromText (type, text) {
    const raw = typeof text === 'string' ? text : ''
    const lines = raw.split('\n')
    switch (type) {
        case 'checklist':
            return {
                items: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => {
                        const match = line.match(/^\s*\[( |x|X)\]\s?(.*)$/)
                        return match
                            ? { text: match[2], done: match[1].toLowerCase() === 'x' }
                            : { text: line.trim(), done: false }
                    }),
            }
        case 'numberedList':
            return {
                items: lines
                    .map((line) => line.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim())
                    .filter((t) => t !== '')
                    .map((t) => ({ text: t })),
            }
        case 'links':
            return {
                links: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => {
                        const [label, url] = line.split('|')
                        return { label: (label || '').trim(), url: (url || '').trim() }
                    }),
            }
        case 'image':
            return { url: (lines[0] || '').trim(), alt: lines.slice(1).join(' ').trim() }
        case 'table':
            return {
                rows: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => line.split(',').map((cell) => cell.trim())),
            }
        default:
            return { text: raw }
    }
}
