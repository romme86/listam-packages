export type BoardStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done'
export type Timeliness = 'on_time' | 'overtime' | 'undertime'

export interface ChecklistItem {
    id: string
    text: string
    done: boolean
}

export interface BoardState {
    id: string
    name: string
    color?: string
    wipLimit?: number
    isDone?: boolean
}

export interface BoardRule {
    id: string
    kind: 'rigor-required' | 'done-gate' | 'wip-limit' | 'required-owner' | 'blocked-reason'
    params?: Record<string, unknown>
    enforce?: 'block' | 'warn'
    enabled?: boolean
}

export interface BoardConfig {
    version: number
    rigorOn: boolean
    states: BoardState[]
    properties: Array<Record<string, unknown>>
    rules: BoardRule[]
    automations: Array<Record<string, unknown>>
}

export interface BoardFields {
    status?: BoardStatus
    description?: string
    checklist?: ChecklistItem[]
    estimatedHours?: number
    estimatedComplexity?: number
    priority?: 'low' | 'medium' | 'high' | 'urgent'
    assignee?: string
    createdBy?: string
    completedBy?: string
    inProgressMs?: number
    inProgressSince?: number | null
    actualInProgressHours?: number
    timeliness?: Timeliness | null
    blocks?: Array<{ id: string; type: string; [key: string]: unknown }>
    boardVersion?: number
}

export interface CongruencyRow {
    user: string
    count: number
    avgComplexity: number
    offEstimateRate: number
    onTimeRate: number
    onTime: number
    over: number
    under: number
    gap: number
    score: number
    tendency: 'underestimates' | 'overestimates' | 'calibrated'
}

export const BOARD_LIST_TYPE: 'board'
export const LEGACY_BOARD_LIST_TYPE: 'kanban'
export const BOARD_WRITE_TYPE: 'board' | 'kanban'
export const BOARD_CONFIG_VERSION: number
export const BOARD_STATUSES: BoardStatus[]
export const TIMELINESS: { ON_TIME: 'on_time'; OVERTIME: 'overtime'; UNDERTIME: 'undertime' }
export const OVERTIME_THRESHOLD: number
export const UNDERTIME_THRESHOLD: number
export const DEFAULT_BOARD_CONFIG: BoardConfig

export function msToHours (ms: number): number
export function isBoardType (type: unknown): boolean
export function isBoardTicket (item: unknown): boolean
export function isBoardStatus (status: unknown): boolean
export function doneStatusesOf (config?: BoardConfig): string[]
export function normalizeBoardConfig (partial?: Partial<BoardConfig> | null): BoardConfig
export function validateTicketDraft (item: unknown, config?: BoardConfig): { ok: boolean; missing: string[] }
export function computeTimeliness (actualHours: number, estimatedHours: number): Timeliness | null
export function applyStatusTransition (
    existing: Record<string, unknown> | null | undefined,
    incoming: Record<string, unknown>,
    now: number,
    opts?: { writerKey?: string | null; maxSliceMs?: number; doneStatuses?: string[]; inProgressStatus?: string }
): Record<string, unknown>
export function computeCongruency (tickets: unknown[], opts?: { shrinkK?: number }): CongruencyRow[]
export function evaluateRules (
    config: BoardConfig | undefined,
    nextItem: Record<string, unknown>,
    prevItem?: Record<string, unknown> | null,
    allItems?: Array<Record<string, unknown>>
): { ok: boolean; blocked: unknown[]; warnings: unknown[] }

// --- Board presentation helpers (shared by every frontend) -------------------

export type Ticket = Record<string, unknown>

export interface TicketBadgeData {
    priority: string | null
    assignee: string | null
    dueAt: number | null
    checklistDone: number
    checklistTotal: number
    inProgressMs: number
    inProgressHours: number
    estimatedHours: number | null
    estimatedComplexity: number | null
    timeliness: Timeliness | null
    isDone: boolean
    running: boolean
}

export interface BoardColumn<T = Ticket> {
    state: BoardState
    tickets: T[]
}

export function selectTickets <T = Ticket>(items: readonly T[] | null | undefined): T[]
export function groupByStatus <T = Ticket>(items: readonly T[] | null | undefined, config?: Partial<BoardConfig> | null): BoardColumn<T>[]
export function ticketBadges (item: unknown, now?: number): TicketBadgeData
export function buildStatusChange <T = Ticket>(item: T | null | undefined, status: string, now?: number): T | null
export function formatDuration (ms: number): string
export function deltaPercent (actualHours: number, estimatedHours: number): number | null

// --- Block-based ticket body -------------------------------------------------

export type BlockKind = 'markdown' | 'checklist' | 'numberedList' | 'links' | 'image' | 'table' | 'callout' | 'code'
export interface BlockTypeSpec { type: BlockKind; icon: string; labelKey: string }
export interface TicketBlock { id: string; type: string; [key: string]: unknown }

export const BLOCK_TYPES: BlockTypeSpec[]
export function isBlockType (type: unknown): boolean
export function normalizeBlocks (blocks: unknown): TicketBlock[]
export function createBlock (type: string, id: string): TicketBlock
export function blockToText (block: TicketBlock | null | undefined): string
export function blockFromText (type: string, text: string): Record<string, unknown>

// Table block (row 0 = header) structural helpers. All return a rectangular
// grid of cell strings with at least one row and one column.
export function normalizeTableRows (rows: unknown): string[][]
export function tableAddRow (rows: unknown): string[][]
export function tableAddColumn (rows: unknown): string[][]
export function tableRemoveRow (rows: unknown, at: number): string[][]
export function tableRemoveColumn (rows: unknown, at: number): string[][]
