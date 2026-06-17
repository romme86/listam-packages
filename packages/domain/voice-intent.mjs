// Pure intent parser for the voice assistant.
//
// Turns an STT transcript into a structured command. Deterministic and
// dependency-free so it unit-tests without any audio/STT/autobase. A QVAC
// local-LLM JSON-intent path can later implement the same return shape behind a
// feature flag; this grammar stays as the offline fallback.
//
//   parseIntent(transcript, locale?) -> {
//     intent: 'add_item' | 'remove_item' | 'note' | 'unknown',
//     slots:  { item?, list?, text? },
//     confidence: number,   // 0..1
//     raw:    string,       // the normalized transcript actually parsed
//   }

import { grammarFor, WAKE_PHRASES } from './voice-grammar.mjs'

// Lowercase, fold diacritics (so "añade"/"anade" match), collapse whitespace,
// drop surrounding punctuation. STT output is noisy on accents/casing.
export function normalizeTranscript (input) {
    if (typeof input !== 'string') return ''
    return input
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip combining marks (accents)
        .toLowerCase()
        .replace(/[.,!?;:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function escapeRegex (s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Build an alternation, longest-first so multi-word phrases win over prefixes
// ("take a note" before "note", "hey listam" before a bare token).
function alternation (phrases) {
    return [...phrases]
        .map(normalizeTranscript)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|')
}

function stripWakePrefix (text) {
    const re = new RegExp(`^(?:${alternation(WAKE_PHRASES)})\\b[\\s,]*`, 'i')
    return text.replace(re, '').trim()
}

function cleanSlot (s) {
    return (s || '').replace(/\s+/g, ' ').trim()
}

// A note can itself contain the words "add" or "remove", so it is checked
// first: if the utterance opens with a note marker, the whole thing is a note.
function tryNote (text, g) {
    const starts = alternation(g.note.starts)
    const ends = alternation(g.note.ends)
    const startRe = new RegExp(`^(?:${starts})\\b[\\s,:-]*`, 'i')
    if (!startRe.test(text)) return null
    let body = text.replace(startRe, '')
    let bothMarkers = false
    const endRe = new RegExp(`[\\s,:-]*\\b(?:${ends})\\s*$`, 'i')
    if (endRe.test(body)) {
        body = body.replace(endRe, '')
        bothMarkers = true
    }
    const noteText = cleanSlot(body)
    if (!noteText) return { intent: 'note', slots: { text: '' }, confidence: 0.4, raw: text }
    return { intent: 'note', slots: { text: noteText }, confidence: bothMarkers ? 0.95 : 0.7, raw: text }
}

function tryAdd (text, g) {
    const verbs = alternation(g.add.verbs)
    const joiners = alternation(g.add.joiners)
    // "add <item> to <list>"
    const withList = new RegExp(`^(?:${verbs})\\s+(?<item>.+?)\\s+(?:${joiners})\\s+(?<list>.+)$`, 'i')
    const m = text.match(withList)
    if (m) {
        const item = cleanSlot(m.groups.item)
        const list = cleanSlot(m.groups.list)
        if (item && list) return { intent: 'add_item', slots: { item, list }, confidence: 0.9, raw: text }
    }
    // "add <item>" (no list -> default)
    const bare = new RegExp(`^(?:${verbs})\\s+(?<item>.+)$`, 'i')
    const m2 = text.match(bare)
    if (m2) {
        const item = cleanSlot(m2.groups.item)
        if (item) return { intent: 'add_item', slots: { item, list: null }, confidence: 0.75, raw: text }
    }
    return null
}

function tryRemove (text, g) {
    const verbs = alternation(g.remove.verbs)
    const re = new RegExp(`^(?:${verbs})\\s+(?<item>.+)$`, 'i')
    const m = text.match(re)
    if (m) {
        const item = cleanSlot(m.groups.item)
        if (item) return { intent: 'remove_item', slots: { item }, confidence: 0.85, raw: text }
    }
    return null
}

export function parseIntent (transcript, locale = 'en') {
    const g = grammarFor(locale)
    const text = stripWakePrefix(normalizeTranscript(transcript))
    if (!text) return { intent: 'unknown', slots: {}, confidence: 0, raw: text }
    return (
        tryNote(text, g) ||
        tryAdd(text, g) ||
        tryRemove(text, g) ||
        { intent: 'unknown', slots: {}, confidence: 0, raw: text }
    )
}
