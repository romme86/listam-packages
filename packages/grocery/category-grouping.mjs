import { CATEGORY_ORDER } from './category-constants.mjs'
import { getCategoryForItem, detectDominantLanguage } from './category-lookup.mjs'
import { CATEGORY_TRANSLATIONS } from './category-translations.mjs'

export function getDisplayCategoryName(canonicalKey, lang) {
    return CATEGORY_TRANSLATIONS[canonicalKey]?.[lang]
        ?? CATEGORY_TRANSLATIONS[canonicalKey]?.en
        ?? canonicalKey
}

export function groupByCategory(data, preferredLang) {
    if (!data || data.length === 0) return []

    const lang = preferredLang || detectDominantLanguage(data.map(e => e?.text ?? ''))
    const categoryMap = new Map()

    for (let i = 0; i < data.length; i++) {
        const entry = data[i]
        const category = getCategoryForItem(entry?.text, lang)

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
