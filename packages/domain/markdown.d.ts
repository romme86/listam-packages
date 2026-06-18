// Shared markdown <-> HTML bridge for the app's whitelisted subset.
export function escapeHtml(value: unknown): string
export function inlineMarkdownToHtml(text: string | null | undefined): string
export function markdownToHtml(text: string | null | undefined): string
export function htmlToMarkdown(html: string | null | undefined): string
