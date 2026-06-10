export function toRawLookupText(text) {
    if (typeof text !== 'string') return ''
    return text
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim()
}

export function normalizeGroceryText(text) {
    return toRawLookupText(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/gu, '')
        .replace(/[’']/gu, '')
        .replace(/[-_/()[\]{}.,;:]+/gu, ' ')
        .replace(/[\u060C\u061B\u061F\u2000-\u206F\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/gu, ' ')
        .replace(/[^\w\s\u0080-\uFFFF]/g, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
}

export function getFirstAsciiLetter(text) {
    if (typeof text !== 'string') return 'a'
    const match = text.match(/[a-zA-Z]/)
    return match ? match[0].toLowerCase() : 'a'
}

export function hasLookupToken(text, token) {
    if (!text || !token) return false
    if (/^[a-z0-9 ]+$/i.test(token)) {
        return new RegExp(`(^|\\s)${escapeRegExp(token)}($|\\s)`, 'i').test(text)
    }
    return text.includes(token)
}

export function containsLookupTerm(text, term) {
    if (!text || !term) return false
    if (/^[a-z0-9 ]+$/i.test(term)) {
        return new RegExp(`(^|\\s)${escapeRegExp(term)}($|\\s)`, 'i').test(text)
    }
    return text.includes(term)
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
