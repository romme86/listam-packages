// Per-locale recognizer phrase tables for the voice assistant.
//
// These are the SPOKEN-language alternates the intent parser matches against —
// deliberately separate from the i18n UI catalogs (those are display strings,
// these are how a person actually phrases a command). English is complete and is
// the validated v1 path; the other five locales carry a first-pass keyword set
// and the parser falls back to English when a locale is missing.
//
// Each command exposes plain keyword arrays so the parser can build accent- and
// case-insensitive alternations without per-locale code.

export const VOICE_LOCALES = ['en', 'es', 'de', 'fr', 'it', 'pt']

// Leading wake words the leaf may include in the streamed pre-roll. Stripped
// before parsing so "yo petito add milk" parses the same as "add milk".
// Bare "yo" remains here only because the on-device model may include it in a
// capture; it is deliberately NOT an address phrase below.
// 'io' is whisper's dominant Italian mishearing of "yo" — accepted so a missed
// on-device wake can still be rescued from the transcript. 'e' is NOT accepted:
// ambient noise transcribes as "e" and would light the LED on every loud sound.
export const WAKE_PHRASES = [
    'yo petito', 'io petito', 'yoo petito',
    'petito',
    'yo', 'yoooo', 'yooo', 'yoo', 'io',
    'hey listam', 'hey, listam', 'a listam', 'hey listen',
    'dai dai dai dai', 'dai dai dai', 'dai dai',
]

// Phrases strong enough to authorize a mutation. The tiny on-device "yo" model
// is now only stage one of the cascade: it opens the capture and permits a pause;
// Whisper must then hear a longer phrase before anything can change a list.
export const ADDRESS_PHRASES = [
    'yo petito', 'io petito', 'yoo petito',
    'petito',
    'hey listam', 'hey, listam',
    'dai dai dai dai',
]

const GRAMMARS = {
    en: {
        add: { verbs: ['add', 'put'], joiners: ['to', 'on', 'in', 'into'] },
        remove: { verbs: ['remove', 'delete', 'take off'] },
        // 'and note' is a frequent STT mishearing of the "end note" terminator.
        note: { starts: ['note', 'new note', 'take a note'], ends: ['end note', 'end of note', 'and note'] },
    },
    es: {
        add: { verbs: ['anade', 'agrega', 'agregar', 'anadir', 'pon'], joiners: ['a', 'en', 'a la', 'al'] },
        remove: { verbs: ['quita', 'elimina', 'borra', 'quitar', 'eliminar'] },
        note: { starts: ['nota', 'nueva nota', 'toma nota'], ends: ['fin de la nota', 'fin de nota', 'termina nota'] },
    },
    de: {
        // German "füge X zu Y hinzu" is separable; the trailing "hinzu" is also
        // accepted as a verb token so the joiner split still works.
        add: { verbs: ['fuge', 'hinzufugen', 'setze', 'pack'], joiners: ['zu', 'in', 'auf', 'in die'] },
        remove: { verbs: ['entferne', 'losche', 'streiche'] },
        note: { starts: ['notiz', 'neue notiz'], ends: ['notiz ende', 'ende der notiz', 'ende notiz'] },
    },
    fr: {
        add: { verbs: ['ajoute', 'ajouter', 'mets'], joiners: ['a', 'dans', 'sur', 'a la', 'au'] },
        remove: { verbs: ['supprime', 'enleve', 'retire', 'efface'] },
        note: { starts: ['note', 'nouvelle note', 'prends note'], ends: ['fin de la note', 'fin de note'] },
    },
    it: {
        // Frequent Whisper renderings of the imperative. "adungi" occurs when
        // the doubled consonant is lost (observed on "aggiungi pannolini").
        add: { verbs: ['aggiungi', 'aggiungo', 'adungi', 'agiungi', 'metti'], joiners: ['a', 'alla', 'al', 'in', 'nella', 'nel'] },
        remove: { verbs: ['rimuovi', 'elimina', 'togli', 'cancella'] },
        note: { starts: ['nota', 'nuova nota', 'prendi nota'], ends: ['fine nota', 'fine della nota'] },
    },
    pt: {
        add: { verbs: ['adiciona', 'adicionar', 'poe', 'coloca'], joiners: ['a', 'na', 'no', 'em'] },
        remove: { verbs: ['remove', 'apaga', 'elimina', 'tira'] },
        note: { starts: ['nota', 'nova nota', 'tomar nota'], ends: ['fim da nota', 'fim de nota'] },
    },
}

export function grammarFor (locale) {
    return GRAMMARS[locale] || GRAMMARS.en
}

export function allGrammars () {
    return GRAMMARS
}
