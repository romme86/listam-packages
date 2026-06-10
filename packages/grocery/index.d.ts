export const SUPPORTED_LANGS: readonly ['en', 'it', 'de', 'nl', 'es', 'pt', 'fr', 'zh', 'ru', 'ja', 'ko', 'ar', 'hi']
export type SupportedLang = typeof SUPPORTED_LANGS[number]

export const CATEGORY_ORDER: string[]
export const MULTILANG_ITEM_TO_CATEGORY: Record<string, string>
export const CATEGORY_TRANSLATIONS: Record<string, Partial<Record<SupportedLang, string>>>
export const LANG_ITEM_SETS: Record<SupportedLang, Set<string>>
export const TRANSLATED_ITEM_TO_EN: Record<string, string>

export type IndexedEntry<T = unknown> = { entry: T; originalIndex: number }
export type CategorySection<T = unknown> = {
    canonicalKey: string
    category: string
    items: Array<IndexedEntry<T>>
}

export function toRawLookupText(text: unknown): string
export function normalizeGroceryText(text: unknown): string
export function getFirstAsciiLetter(text: unknown): string
export function hasLookupToken(text: string, token: string): boolean
export function containsLookupTerm(text: string, term: string): boolean
export function detectDominantLanguage(items: string[]): SupportedLang
export function getCategoryForItem(text: unknown, preferredLang?: SupportedLang): string
export function getDisplayCategoryName(canonicalKey: string, lang: SupportedLang): string
export function groupByCategory<T extends { text?: string; isDone?: boolean }>(data: T[], preferredLang?: SupportedLang): Array<CategorySection<T>>
