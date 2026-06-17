import { CATEGORY_ORDER } from './category-constants.mjs'
import { getCategoryForItem, detectDominantLanguage } from './category-lookup.mjs'
import { CATEGORY_TRANSLATIONS } from './category-translations.mjs'

const VALID_CATEGORIES = new Set(CATEGORY_ORDER)

export function getDisplayCategoryName(canonicalKey, lang) {
    return CATEGORY_TRANSLATIONS[canonicalKey]?.[lang]
        ?? CATEGORY_TRANSLATIONS[canonicalKey]?.en
        ?? canonicalKey
}

// An entry may pin itself to a category the text classifier wouldn't pick —
// e.g. the user dragged it there. A non-empty `categoryOverride` that names a
// known canonical category wins over text classification.
export function getEntryCategory(entry, lang) {
    const override = entry?.categoryOverride
    if (typeof override === 'string' && VALID_CATEGORIES.has(override)) {
        return override
    }
    return getCategoryForItem(entry?.text, lang)
}

export function groupByCategory(data, preferredLang) {
    if (!data || data.length === 0) return []

    const lang = preferredLang || detectDominantLanguage(data.map(e => e?.text ?? ''))
    const categoryMap = new Map()

    for (let i = 0; i < data.length; i++) {
        const entry = data[i]
        const category = getEntryCategory(entry, lang)

        if (!categoryMap.has(category)) {
            categoryMap.set(category, [])
        }
        categoryMap.get(category).push({ entry, originalIndex: i })
    }

    for (const items of categoryMap.values()) {
        items.sort((a, b) => {
            if (a.entry.isDone === b.entry.isDone) return 0
            return a.entry.isDone ? 1 : -1
        })
    }

    const sections = []
    for (const canonicalCategory of CATEGORY_ORDER) {
        const items = categoryMap.get(canonicalCategory)
        if (items && items.length > 0) {
            sections.push({
                canonicalKey: canonicalCategory,
                category: getDisplayCategoryName(canonicalCategory, lang),
                items,
            })
            categoryMap.delete(canonicalCategory)
        }
    }

    for (const [canonicalCategory, items] of categoryMap) {
        if (items.length > 0) {
            sections.push({
                canonicalKey: canonicalCategory,
                category: getDisplayCategoryName(canonicalCategory, lang),
                items,
            })
        }
    }

    return sections
}
