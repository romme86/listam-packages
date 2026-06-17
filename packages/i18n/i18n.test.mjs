import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    EN_MESSAGES,
} from './catalogs/en.mjs'
import {
    ES_MESSAGES,
} from './catalogs/es.mjs'
import { DE_MESSAGES } from './catalogs/de.mjs'
import { FR_MESSAGES } from './catalogs/fr.mjs'
import { IT_MESSAGES } from './catalogs/it.mjs'
import { PT_MESSAGES } from './catalogs/pt.mjs'
import {
    LONG_LOCALE,
    PSEUDO_LOCALE,
    assertCompleteCatalog,
    createI18n,
    createLongStringCatalog,
    createPseudoCatalog,
    getCatalog,
    pseudoLocalizeText,
    resolveGroceryLocale,
    resolveLocale,
} from './index.mjs'

const PHASE_9_SURFACE_KEYS = [
    'main.empty.title',
    'main.summary.itemsLeft',
    'invite.confirm.message',
    'invite.dialog.title',
    'header.setting.appLanguage',
    'header.status.synced',
    'backend.joinSuccess',
    'backend.memberRemoved.success',
    'loyalty.scanner.permission.title',
    'loyalty.viewer.delete.message',
]

test('catalogs have the same typed keys', () => {
    for (const [locale, catalog] of [
        ['es', ES_MESSAGES],
        ['de', DE_MESSAGES],
        ['fr', FR_MESSAGES],
        ['it', IT_MESSAGES],
        ['pt', PT_MESSAGES],
    ]) {
        assert.doesNotThrow(() => assertCompleteCatalog(locale, catalog, EN_MESSAGES))
    }
    assert.doesNotThrow(() => assertCompleteCatalog(PSEUDO_LOCALE, createPseudoCatalog(), EN_MESSAGES))
    assert.doesNotThrow(() => assertCompleteCatalog(LONG_LOCALE, createLongStringCatalog(), EN_MESSAGES))
})

test('locale resolver supports overrides, system fallback, and grocery locale routing', () => {
    assert.equal(resolveLocale('es-MX', 'en-US'), 'es')
    assert.equal(resolveLocale('system', 'es-MX'), 'es')
    assert.equal(resolveLocale('fr-CH', 'fr-CH'), 'fr')
    assert.equal(resolveLocale('system', 'de-CH'), 'de')
    assert.equal(resolveLocale('it-CH', 'en-US'), 'it')
    assert.equal(resolveLocale('pt-BR', 'en-US'), 'pt')
    assert.equal(resolveLocale('ja-JP', 'ja-JP'), 'en')
    assert.equal(resolveLocale(PSEUDO_LOCALE, 'en-US'), PSEUDO_LOCALE)
    assert.equal(resolveGroceryLocale('system', 'de-CH'), 'de')
    assert.equal(resolveGroceryLocale(PSEUDO_LOCALE, 'es-MX'), 'en')
})

test('translations render with interpolation, plural forms, and fallback catalogs', () => {
    const es = createI18n({ localeChoice: 'es', systemLocale: 'en-US' })
    assert.equal(es.t('main.empty.title'), 'Tu lista esta vacia')
    assert.equal(es.t('main.summary.itemsLeft', { count: 1 }), 'Queda 1 articulo')
    assert.equal(es.t('main.summary.itemsLeft', { count: 4 }), 'Quedan 4 articulos')
    assert.match(es.t('loyalty.viewer.delete.message', { name: 'Coop' }), /Coop/)

    const fr = createI18n({ localeChoice: 'fr' })
    assert.equal(fr.t('main.empty.title'), 'Votre liste est vide')
    assert.equal(fr.t('main.summary.itemsLeft', { count: 2 }), '2 articles restants')

    const de = createI18n({ localeChoice: 'de' })
    assert.equal(de.t('main.empty.title'), 'Deine Liste ist leer')

    // A language with no UI catalog still falls back to the English source.
    assert.equal(createI18n({ localeChoice: 'ja' }).t('main.empty.title'), 'Your list is empty')
})

test('Intl helpers format numbers and dates without leaking message syntax', () => {
    const i18n = createI18n({ localeChoice: 'en' })
    assert.equal(i18n.number(1234).includes('1'), true)
    assert.equal(i18n.date(new Date('2026-06-09T00:00:00Z'), { year: 'numeric' }).includes('2026'), true)
    assert.equal(i18n.t('invite.share.message', {
        inviteLink: 'https://listam.ch/join?invite=abc',
        inviteKey: 'abc',
    }).includes('{invite'), false)
})

test('pseudo and long catalogs cover the phase 9 surfaces', () => {
    const pseudo = getCatalog(PSEUDO_LOCALE)
    const long = getCatalog(LONG_LOCALE)

    for (const key of PHASE_9_SURFACE_KEYS) {
        const enValue = EN_MESSAGES[key]
        const enText = typeof enValue === 'string' ? enValue : enValue.other
        const pseudoValue = pseudo[key]
        const pseudoText = typeof pseudoValue === 'string' ? pseudoValue : pseudoValue.other
        const longValue = long[key]
        const longText = typeof longValue === 'string' ? longValue : longValue.other

        assert.equal(pseudoText.startsWith('['), true, key)
        assert.equal(pseudoText.includes('{count}') || !enText.includes('{count}'), true, key)
        assert.equal(longText.length > enText.length, true, key)
    }
})

test('pseudo-localization preserves placeholders', () => {
    const localized = pseudoLocalizeText('Saved {name} card')
    assert.match(localized, /\{name\}/)
    assert.notEqual(localized, 'Saved {name} card')
})

test('index.d.ts MessageKey union exactly matches the runtime catalog keys', () => {
    const dts = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')

    // Isolate the `export type MessageKey = | '...' | '...'` union, which ends
    // at the next top-level `export` declaration.
    const start = dts.indexOf('export type MessageKey =')
    assert.notEqual(start, -1, 'could not find MessageKey union in index.d.ts')
    const after = dts.indexOf('\nexport ', start + 1)
    const block = after === -1 ? dts.slice(start) : dts.slice(start, after)

    const unionKeys = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const runtimeKeys = Object.keys(EN_MESSAGES)

    const unionSet = new Set(unionKeys)
    const runtimeSet = new Set(runtimeKeys)

    const missingFromDts = runtimeKeys.filter((k) => !unionSet.has(k))
    const extraInDts = unionKeys.filter((k) => !runtimeSet.has(k))

    assert.deepEqual(missingFromDts, [], `keys in en.mjs but missing from index.d.ts MessageKey: ${missingFromDts.join(', ')}`)
    assert.deepEqual(extraInDts, [], `keys in index.d.ts MessageKey but absent from en.mjs: ${extraInDts.join(', ')}`)
    assert.equal(unionSet.size, unionKeys.length, 'index.d.ts MessageKey contains duplicate keys')
})
