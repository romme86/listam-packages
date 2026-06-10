import {
    MULTILANG_ITEM_TO_CATEGORY,
    LANG_ITEM_SETS,
    SUPPORTED_LANGS,
} from './category-translations.mjs'
import {
    containsLookupTerm,
    hasLookupToken,
    normalizeGroceryText,
    toRawLookupText,
} from './grocery-text.mjs'

const KEYWORD_HINTS = new Map([
    ['berry', 'Fruits'], ['berries', 'Fruits'], ['fruit', 'Fruits'],
    ['apple', 'Fruits'], ['banana', 'Fruits'], ['grape', 'Fruits'], ['mango', 'Fruits'],
    ['citrus', 'Fruits'], ['melon', 'Fruits'],
    ['lettuce', 'Vegetables'], ['salad', 'Vegetables'], ['veggie', 'Vegetables'],
    ['vegetable', 'Vegetables'], ['herb', 'Vegetables'], ['sprout', 'Vegetables'],
    ['bread', 'Bread & Bakery'], ['bagel', 'Bread & Bakery'], ['croissant', 'Bread & Bakery'],
    ['muffin', 'Bread & Bakery'], ['cake', 'Bread & Bakery'], ['pastry', 'Bread & Bakery'],
    ['bun', 'Bread & Bakery'], ['roll', 'Bread & Bakery'],
    ['chicken', 'Meat'], ['beef', 'Meat'], ['pork', 'Meat'], ['lamb', 'Meat'],
    ['steak', 'Meat'], ['sausage', 'Meat'], ['mince', 'Meat'], ['meat', 'Meat'],
    ['bacon', 'Meat'], ['turkey', 'Meat'],
    ['fish', 'Fish & Seafood'], ['salmon', 'Fish & Seafood'], ['tuna', 'Fish & Seafood'],
    ['shrimp', 'Fish & Seafood'], ['prawn', 'Fish & Seafood'], ['seafood', 'Fish & Seafood'],
    ['milk', 'Dairy'], ['cheese', 'Dairy'], ['yogurt', 'Dairy'], ['yoghurt', 'Dairy'],
    ['cream', 'Dairy'], ['butter', 'Dairy'], ['egg', 'Dairy'],
    ['canned', 'Canned Goods'], ['tinned', 'Canned Goods'],
    ['pasta', 'Pasta/Rice/Cereal'], ['rice', 'Pasta/Rice/Cereal'], ['cereal', 'Pasta/Rice/Cereal'],
    ['noodle', 'Pasta/Rice/Cereal'], ['oat', 'Pasta/Rice/Cereal'],
    ['sauce', 'Condiments & Spices'], ['oil', 'Condiments & Spices'],
    ['spice', 'Condiments & Spices'], ['seasoning', 'Condiments & Spices'],
    ['vinegar', 'Condiments & Spices'], ['dressing', 'Condiments & Spices'],
    ['flour', 'Baking'], ['sugar', 'Baking'], ['baking', 'Baking'],
    ['chips', 'Snacks'], ['snack', 'Snacks'], ['chocolate', 'Snacks'], ['candy', 'Snacks'],
    ['nut', 'Snacks'], ['nuts', 'Snacks'], ['seed', 'Snacks'], ['seeds', 'Snacks'],
    ['juice', 'Beverages'], ['coffee', 'Beverages'], ['tea', 'Beverages'],
    ['water', 'Beverages'], ['wine', 'Beverages'], ['beer', 'Beverages'],
    ['drink', 'Beverages'], ['soda', 'Beverages'],
    ['frozen', 'Frozen Foods'], ['ice cream', 'Frozen Foods'],
    ['shampoo', 'Personal Care'], ['toothpaste', 'Personal Care'],
    ['deodorant', 'Personal Care'], ['soap', 'Personal Care'],
    ['detergent', 'Household & Cleaning'], ['cleaner', 'Household & Cleaning'],
    ['sponge', 'Household & Cleaning'], ['towel', 'Household & Cleaning'],
    ['foil', 'Household & Cleaning'], ['wrap', 'Household & Cleaning'],
    ['baby', 'Baby Items'], ['diaper', 'Baby Items'], ['nappy', 'Baby Items'],
    ['dog', 'Pet Care'], ['cat', 'Pet Care'], ['pet', 'Pet Care'],
])

const NORMALIZED_ITEM_TO_CATEGORY = {}
const NORMALIZED_LANG_ITEM_SETS = {}
const MULTILANG_ENTRIES = Object.entries(MULTILANG_ITEM_TO_CATEGORY)
    .sort(([a], [b]) => b.length - a.length)

for (const [item, category] of MULTILANG_ENTRIES) {
    const normalized = normalizeGroceryText(item)
    if (normalized && !NORMALIZED_ITEM_TO_CATEGORY[normalized]) {
        NORMALIZED_ITEM_TO_CATEGORY[normalized] = category
    }
}

for (const lang of SUPPORTED_LANGS) {
    NORMALIZED_LANG_ITEM_SETS[lang] = new Set(
        Array.from(LANG_ITEM_SETS[lang], item => normalizeGroceryText(item)).filter(Boolean),
    )
}

const CATEGORY_OVERRIDES = new Map([
    ['pepper', 'Condiments & Spices'],
    ['pepe', 'Condiments & Spices'],
    ['peper', 'Condiments & Spices'],
    ['pfeffer', 'Condiments & Spices'],
    ['pimienta', 'Condiments & Spices'],
    ['pimenta', 'Condiments & Spices'],
    ['poivre', 'Condiments & Spices'],
    ['胡椒', 'Condiments & Spices'],
    ['перец', 'Condiments & Spices'],
    ['こしょう', 'Condiments & Spices'],
    ['후추', 'Condiments & Spices'],
    ['فلفل', 'Condiments & Spices'],
    ['काली मिर्च', 'Condiments & Spices'],
    ['burrata', 'Dairy'],
    ['cracker', 'Snacks'],
    ['crackers', 'Snacks'],
    ['raisins', 'Snacks'],
    ['milk chocolate bar', 'Snacks'],
    ['white chocolate bar', 'Snacks'],
    ['dark chocolate bar', 'Snacks'],
    ['chocolate bar', 'Snacks'],
    ['macadamia nuts', 'Snacks'],
    ['pine nuts', 'Snacks'],
    ['pumpkin seeds', 'Snacks'],
    ['sunflower seeds', 'Snacks'],
    ['sweet chili sauce', 'Condiments & Spices'],
    ['sweet chile sauce', 'Condiments & Spices'],
    ['sweet chilli sauce', 'Condiments & Spices'],
])

const MODIFIER_RULES = [
    {
        category: 'Ready Meals',
        terms: [
            'ready meal', 'ready to eat', 'pre made', 'premade',
            'pre cooked', 'microwave', 'meal kit', 'rotisserie', 'stuffed',
            'marinated', 'deli wrap', 'pre made sandwich', 'meal prep bowl',
        ],
    },
    {
        category: 'Frozen Foods',
        terms: [
            'frozen', 'freezer', 'surgelato', 'surgelati', 'tiefgekuhlt',
            'diepvries', 'congelado', 'congelados', 'surgele', 'surgeles',
        ],
    },
    {
        category: 'Canned Goods',
        terms: [
            'canned', 'tinned', 'tin', 'jarred', 'in scatola', 'aus der dose',
            'uit blik', 'enlatado', 'enlatados', 'en conserve',
        ],
    },
    {
        category: 'Health & Organic',
        terms: [
            'organic', 'bio', 'biologico', 'biologisch', 'organico',
            'ecologico', 'okologisch',
        ],
    },
    {
        category: 'International Foods',
        terms: [
            'curry paste', 'pad thai', 'lemongrass paste', 'kaffir lime',
            'galangal', 'tamarind', 'rice paper', 'dashi', 'ponzu', 'yuzu',
            'nori', 'seaweed', 'wakame', 'tempeh', 'natto', 'tofu',
            'gochujang', 'doenjang', 'shaoxing', 'szechuan', 'furikake',
            'panko', 'seitan', 'jaggery', 'besan', 'sambar', 'chaat masala',
            'asafoetida', 'miso paste', 'kimchi paste', 'belacan',
        ],
    },
]

function levenshtein(a, b) {
    const m = a.length
    const n = b.length
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            )
        }
    }

    return dp[m][n]
}

function stripQuantifiers(text) {
    return text
        .replace(/\b\d+(\.\d+)?\s*(%|g|kg|ml|l|lb|oz|ct|pk|pack|packs|bag|bags|can|cans|tin|tins)\b/giu, '')
        .replace(/\b(fresh|free range|whole|large|small|medium|extra|lite|light|low fat|fat free|sugar free|gluten free|natural|raw|smoked|sliced|diced|chopped|ground|minced|boneless|skinless)\b/giu, '')
        .replace(/\s+/gu, ' ')
        .trim()
}

function lookupCategory(raw, normalized) {
    return MULTILANG_ITEM_TO_CATEGORY[raw]
        ?? MULTILANG_ITEM_TO_CATEGORY[normalized]
        ?? NORMALIZED_ITEM_TO_CATEGORY[normalized]
}

function getOverrideCategory(normalized) {
    return CATEGORY_OVERRIDES.get(normalized)
}

function getModifierCategory(normalized) {
    for (const rule of MODIFIER_RULES) {
        if (rule.terms.some(term => containsLookupTerm(normalized, term))) {
            return rule.category
        }
    }
    return undefined
}

export function detectDominantLanguage(items) {
    const scores = {}
    for (const lang of SUPPORTED_LANGS) scores[lang] = 0

    for (const text of items) {
        const raw = toRawLookupText(text)
        const normalized = normalizeGroceryText(text)
        if (!raw && !normalized) continue

        for (const lang of SUPPORTED_LANGS) {
            if (LANG_ITEM_SETS[lang].has(raw) || NORMALIZED_LANG_ITEM_SETS[lang].has(normalized)) {
                scores[lang]++
            }
        }
    }

    let best = 'en'
    let bestScore = 0
    for (const lang of SUPPORTED_LANGS) {
        if (scores[lang] > bestScore) {
            bestScore = scores[lang]
            best = lang
        }
    }
    return best
}

export function getCategoryForItem(text, preferredLang) {
    try {
        const raw = toRawLookupText(text)
        const normalized = normalizeGroceryText(text)
        if (!raw && !normalized) return 'Others'

        const modifierCategory = getModifierCategory(normalized)
        if (modifierCategory) return modifierCategory

        const override = getOverrideCategory(normalized)
        if (override) return override

        const exact = lookupCategory(raw, normalized)
        if (exact) return exact

        const stripped = stripQuantifiers(normalized)
        if (stripped && stripped !== normalized) {
            const strippedModifierCategory = getModifierCategory(stripped)
            if (strippedModifierCategory) return strippedModifierCategory

            const strippedOverride = getOverrideCategory(stripped)
            if (strippedOverride) return strippedOverride

            const strippedMatch = lookupCategory(stripped, stripped)
            if (strippedMatch) return strippedMatch
        }

        for (const [keyword, category] of KEYWORD_HINTS) {
            if (hasLookupToken(normalized, keyword)) {
                return category
            }
        }

        for (const [key, category] of MULTILANG_ENTRIES) {
            const normalizedKey = normalizeGroceryText(key)
            if (normalizedKey.length >= 4 && containsLookupTerm(normalized, normalizedKey)) {
                return category
            }
        }

        const maxDistance = normalized.length <= 5 ? 1 : 2

        if (preferredLang) {
            for (const key of NORMALIZED_LANG_ITEM_SETS[preferredLang]) {
                if (levenshtein(normalized, key) <= maxDistance) {
                    return NORMALIZED_ITEM_TO_CATEGORY[key] ?? MULTILANG_ITEM_TO_CATEGORY[key] ?? 'Others'
                }
            }
        }

        for (const [keyword, category] of KEYWORD_HINTS) {
            if (levenshtein(normalized, keyword) <= maxDistance) {
                return category
            }
        }

        const words = normalized.split(/\s+/u)
        for (const word of words) {
            if (word.length < 3) continue
            const wordMaxDist = word.length <= 5 ? 1 : 2
            for (const [keyword, category] of KEYWORD_HINTS) {
                if (levenshtein(word, keyword) <= wordMaxDist) {
                    return category
                }
            }
        }

        return 'Others'
    } catch {
        return 'Others'
    }
}
