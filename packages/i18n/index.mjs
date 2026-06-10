import { EN_MESSAGES } from './catalogs/en.mjs'
import { ES_MESSAGES } from './catalogs/es.mjs'

export const DEFAULT_LOCALE = 'en'
export const PSEUDO_LOCALE = 'en-XA'
export const LONG_LOCALE = 'en-XL'
export const SYSTEM_LOCALE_CHOICE = 'system'
export const SUPPORTED_UI_LOCALES = ['en', 'es']
export const SPECIAL_TEST_LOCALES = [PSEUDO_LOCALE, LONG_LOCALE]
export const LOCALE_CHOICES = [SYSTEM_LOCALE_CHOICE, ...SUPPORTED_UI_LOCALES, ...SPECIAL_TEST_LOCALES]
export const GROCERY_LOCALES = ['en', 'it', 'de', 'nl', 'es', 'pt', 'fr', 'zh', 'ru', 'ja', 'ko', 'ar', 'hi']

export const catalogByLocale = {
    en: EN_MESSAGES,
    es: ES_MESSAGES,
}

export const LOCALE_LABEL_KEYS = {
    system: 'app.locale.system',
    en: 'app.locale.english',
    es: 'app.locale.spanish',
    [PSEUDO_LOCALE]: 'app.locale.pseudo',
    [LONG_LOCALE]: 'app.locale.long',
}

export const MESSAGE_KEYS = Object.freeze(Object.keys(EN_MESSAGES))

const PLACEHOLDER_RE = /(\{[^}]+\})/gu
const PSEUDO_MAP = new Map(Object.entries({
    a: 'aa', b: 'b', c: 'c', d: 'd', e: 'ee', f: 'f', g: 'g', h: 'h',
    i: 'ii', j: 'j', k: 'k', l: 'l', m: 'm', n: 'n', o: 'oo', p: 'p',
    q: 'q', r: 'r', s: 's', t: 't', u: 'uu', v: 'v', w: 'w', x: 'x',
    y: 'y', z: 'z',
    A: 'AA', B: 'B', C: 'C', D: 'D', E: 'EE', F: 'F', G: 'G', H: 'H',
    I: 'II', J: 'J', K: 'K', L: 'L', M: 'M', N: 'N', O: 'OO', P: 'P',
    Q: 'Q', R: 'R', S: 'S', T: 'T', U: 'UU', V: 'V', W: 'W', X: 'X',
    Y: 'Y', Z: 'Z',
}))

export function isLocaleChoice(value) {
    return typeof value === 'string' && LOCALE_CHOICES.includes(value)
}

export function normalizeLocale(value) {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (trimmed.toLowerCase() === SYSTEM_LOCALE_CHOICE) return SYSTEM_LOCALE_CHOICE
    if (trimmed.toLowerCase() === PSEUDO_LOCALE.toLowerCase()) return PSEUDO_LOCALE
    if (trimmed.toLowerCase() === LONG_LOCALE.toLowerCase()) return LONG_LOCALE

    try {
        const [canonical] = Intl.getCanonicalLocales(trimmed)
        return canonical || trimmed
    } catch {
        return trimmed
    }
}

export function getLocaleLanguage(locale) {
    const normalized = normalizeLocale(locale)
    if (!normalized || normalized === SYSTEM_LOCALE_CHOICE) return ''
    return normalized.split('-')[0]?.toLowerCase() || ''
}

export function matchSupportedLocale(locale) {
    const normalized = normalizeLocale(locale)
    if (normalized === PSEUDO_LOCALE || normalized === LONG_LOCALE) return normalized
    const language = getLocaleLanguage(normalized)
    if (SUPPORTED_UI_LOCALES.includes(language)) return language
    return DEFAULT_LOCALE
}

export function resolveLocale(localeChoice = SYSTEM_LOCALE_CHOICE, systemLocale = DEFAULT_LOCALE) {
    const choice = normalizeLocale(localeChoice) || SYSTEM_LOCALE_CHOICE
    if (choice !== SYSTEM_LOCALE_CHOICE) return matchSupportedLocale(choice)
    return matchSupportedLocale(systemLocale)
}

export function resolveGroceryLocale(localeChoice = SYSTEM_LOCALE_CHOICE, systemLocale = DEFAULT_LOCALE) {
    const choice = normalizeLocale(localeChoice) || SYSTEM_LOCALE_CHOICE
    const source = choice === SYSTEM_LOCALE_CHOICE ? systemLocale : choice
    const language = getLocaleLanguage(source)
    return GROCERY_LOCALES.includes(language) ? language : DEFAULT_LOCALE
}

export function getCatalog(locale) {
    const resolved = matchSupportedLocale(locale)
    if (resolved === PSEUDO_LOCALE) return createPseudoCatalog(EN_MESSAGES)
    if (resolved === LONG_LOCALE) return createLongStringCatalog(EN_MESSAGES)
    return catalogByLocale[resolved] ?? EN_MESSAGES
}

export function createI18n(options = {}) {
    const localeChoice = normalizeLocale(options.localeChoice ?? options.locale) || SYSTEM_LOCALE_CHOICE
    const systemLocale = normalizeLocale(options.systemLocale) || DEFAULT_LOCALE
    const locale = resolveLocale(localeChoice, systemLocale)
    const groceryLocale = resolveGroceryLocale(localeChoice, systemLocale)
    const catalog = getCatalog(locale)

    const i18n = {
        locale,
        localeChoice,
        systemLocale,
        groceryLocale,
        catalog,
        t(key, values) {
            return translate(catalog, key, values, locale)
        },
        number(value, options) {
            return formatNumber(value, locale, options)
        },
        date(value, options) {
            return formatDate(value, locale, options)
        },
        plural(count, forms) {
            return selectPluralForm(forms, count, locale)
        },
    }

    return i18n
}

export function translate(catalog, key, values = {}, locale = DEFAULT_LOCALE) {
    const fallback = EN_MESSAGES[key] ?? key
    const rawMessage = catalog?.[key] ?? fallback
    const selected = selectPluralMessage(rawMessage, values.count, locale)
    return interpolate(selected, values)
}

export function selectPluralMessage(message, count, locale = DEFAULT_LOCALE) {
    if (typeof message === 'string') return message
    if (!message || typeof message !== 'object') return ''

    if (typeof count === 'number' && count === 0 && typeof message.zero === 'string') {
        return message.zero
    }

    const form = selectPluralForm(message, Number(count), locale)
    return form ?? message.other ?? message.one ?? ''
}

export function selectPluralForm(forms, count, locale = DEFAULT_LOCALE) {
    if (!forms || typeof forms !== 'object') return ''
    const safeCount = Number.isFinite(count) ? count : 0
    let rule = 'other'
    try {
        rule = new Intl.PluralRules(locale).select(safeCount)
    } catch {
        rule = safeCount === 1 ? 'one' : 'other'
    }
    return forms[rule] ?? forms.other ?? forms.one ?? ''
}

export function interpolate(message, values = {}) {
    if (typeof message !== 'string') return ''
    return message.replace(/\{(\w+)\}/gu, (match, name) => {
        if (!Object.prototype.hasOwnProperty.call(values, name)) return match
        const value = values[name]
        if (value === null || value === undefined) return ''
        return String(value)
    })
}

export function formatNumber(value, locale = DEFAULT_LOCALE, options) {
    try {
        return new Intl.NumberFormat(locale, options).format(value)
    } catch {
        return String(value)
    }
}

export function formatDate(value, locale = DEFAULT_LOCALE, options) {
    const date = value instanceof Date ? value : new Date(value)
    try {
        return new Intl.DateTimeFormat(locale, options).format(date)
    } catch {
        return date.toISOString()
    }
}

export function pseudoLocalizeText(value, options = {}) {
    if (typeof value !== 'string' || value.length === 0) return value
    const expansion = typeof options.expansion === 'number' ? Math.max(0, options.expansion) : 0.25

    const localized = value
        .split(PLACEHOLDER_RE)
        .map((part) => {
            if (/^\{[^}]+\}$/u.test(part)) return part
            return Array.from(part).map((char) => PSEUDO_MAP.get(char) ?? char).join('')
        })
        .join('')

    const padLength = Math.ceil(stripPlaceholders(value).length * expansion)
    const pad = padLength > 0 ? ` ${'~'.repeat(padLength)}` : ''
    return `[${localized}${pad}]`
}

export function createPseudoCatalog(source = EN_MESSAGES) {
    return mapCatalog(source, (text) => pseudoLocalizeText(text))
}

export function createLongStringCatalog(source = EN_MESSAGES) {
    return mapCatalog(source, (text) => {
        if (!text) return text
        if (text.includes('\n')) {
            return `${text}\n${text}`
        }
        return `${text} ${text}`
    })
}

export function assertCompleteCatalog(locale, catalog, source = EN_MESSAGES) {
    const sourceKeys = Object.keys(source).sort()
    const catalogKeys = Object.keys(catalog ?? {}).sort()
    const missing = sourceKeys.filter((key) => !catalogKeys.includes(key))
    const extra = catalogKeys.filter((key) => !sourceKeys.includes(key))
    if (missing.length || extra.length) {
        const details = [
            missing.length ? `missing: ${missing.join(', ')}` : '',
            extra.length ? `extra: ${extra.join(', ')}` : '',
        ].filter(Boolean).join('; ')
        throw new Error(`${locale} catalog does not match ${DEFAULT_LOCALE}: ${details}`)
    }
}

function mapCatalog(source, mapText) {
    return Object.fromEntries(Object.entries(source).map(([key, value]) => {
        if (typeof value === 'string') return [key, mapText(value)]
        if (value && typeof value === 'object') {
            return [key, Object.fromEntries(Object.entries(value).map(([form, text]) => [form, mapText(text)]))]
        }
        return [key, value]
    }))
}

function stripPlaceholders(value) {
    return value.replace(PLACEHOLDER_RE, '')
}
