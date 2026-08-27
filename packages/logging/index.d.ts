export type LogLevel = 'info' | 'warn' | 'error' | 'fatal' | 'audit' | 'debug' | 'trace'
export type LogRow = {
    ts: string
    level: LogLevel
    app: string
    message: string
    details: unknown[]
}
export type Logger = {
    log: (...args: unknown[]) => void
    info: (message: string, ...details: unknown[]) => void
    warn: (message: string, ...details: unknown[]) => void
    error: (message: string, ...details: unknown[]) => void
}
export type LogTailStats = {
    buffered: number
    dropped: number
    capacity: number
}
export type LogTailBundle = LogTailStats & {
    entries: string[]
}

export function redactForLog(value: unknown, depth?: number, seen?: WeakSet<object>): unknown
export function redactString(value: unknown): string
export function redactForExport(value: unknown): unknown
export function redactDiagnosticBundle(value: unknown): unknown
export function parseLogArgs(args: unknown[], options?: { app?: string }): LogRow
export function formatLogLine(args: unknown[], options?: { app?: string }): string
export const DEFAULT_LOG_TAIL_CAPACITY: number
export const MAX_LOG_TAIL_CAPACITY: number
export function logTail(options?: { limit?: number }): LogTailBundle
export function clearLogTail(): LogTailStats
export function configureLogTail(options?: { capacity?: number }): LogTailStats
export function createLogger(options?: { app?: string; write?: (line: string) => void; tail?: boolean }): Logger
export const logger: Logger
