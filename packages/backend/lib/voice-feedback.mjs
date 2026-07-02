// Maps an STT transcription run onto leaf LED feedback at each recognition
// milestone. Extracted from the headless service so the milestone sequencing is
// unit-testable without whisper / audio / hardware.
//
// The leaf LED is DARK on the on-device loudness gate; it lights only from the
// frames emitted here via `reply` (a per-connection channel from audio-bridge):
//   yellow = wake word recognized · purple = command recognized ·
//   green = saved (red = error). No wake word AND no parseable command => the
//   utterance was ambient noise, so nothing lights. A command can be parsed
//   (yellow→purple) yet still be GATED before green/save — see shouldExecuteIntent
//   and DEFAULT_EXEC_FLOORS — so a likely false positive lights up but never
//   mutates a list.
//
//   const onUtterance = createVoiceFeedbackHandler({ stt, controller,
//     parseIntent, detectWake, locale, logger })
//   await onUtterance(utterance, reply)   // reply = { led(name), done() }
//
// Short dwells between colors keep the sequence visible rather than collapsing
// to a single final flash; they are injectable so tests run instantly.

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

// hold (green) is deliberately long: the confirm arrives ~10s after the user
// spoke (whisper latency), so a sub-second blink is easy to miss entirely.
const DEFAULT_DWELL = { command: 350, hold: 1400, fail: 800 }

// Grammars tried when the spoken language is unknown ('auto'): the six UI
// locales. Order is the tie-break preference when multiple would match.
const AUTO_LANGS = ['en', 'it', 'es', 'de', 'fr', 'pt']

// Write gate (NOT the LED): which parsed commands are allowed to actually execute
// and save. There is no real wake-word model yet — the leaf only has a loudness
// (dB) gate and sends wakeWordId=1 unconditionally (microWakeWord is deferred), so
// ambient speech that happens to parse reaches the host. A clean wake word means
// the user clearly addressed the device, so any recognized command runs. WITHOUT
// a wake word, the parse confidence must clear a per-intent floor:
//   • add_item / note (non-destructive): 0.75 — the anchored "add milk" (0.75)
//     still works hands-free, but the 0.6 lenient-retry path is excluded.
//   • remove_item (DESTRUCTIVE): 0.9 — above the grammar's max for a remove
//     (anchored remove is 0.85), so a wake word is effectively required to delete.
//     handleRemove deletes by substring match, so an ambient "take off your shoes"
//     must never reach it.
// Floors are configurable (config.voice.execConfidence) so the policy can be
// loosened/tightened without code changes once a real wake-word model exists.
export const DEFAULT_EXEC_FLOORS = Object.freeze({
    add_item: 0.75,
    remove_item: 0.9,
    note: 0.75,
})

// Decide whether a parsed intent may execute. Pure so the policy unit-tests in
// isolation. `wake` short-circuits the floor (the user said the wake word); an
// unknown intent never executes; otherwise confidence must clear the per-intent
// floor (intents with no floor entry require an unreachable 1.0, i.e. wake-only).
export function shouldExecuteIntent (intent, { wake = false, floors = DEFAULT_EXEC_FLOORS } = {}) {
    if (!intent || intent.intent === 'unknown') return false
    if (wake) return true
    const floor = floors[intent.intent] ?? 1
    return Number(intent.confidence) >= floor
}

export function createVoiceFeedbackHandler ({
    stt,
    controller,
    parseIntent,
    detectWake,
    locale = 'auto',
    logger = null,
    dwellMs = DEFAULT_DWELL,
    execFloors = DEFAULT_EXEC_FLOORS,
} = {}) {
    if (!stt || !controller || typeof parseIntent !== 'function' || typeof detectWake !== 'function') {
        throw new Error('createVoiceFeedbackHandler requires stt, controller, parseIntent, detectWake')
    }
    const dwell = { ...DEFAULT_DWELL, ...dwellMs }
    const floors = { ...DEFAULT_EXEC_FLOORS, ...execFloors }
    const log = (m) => { try { logger?.log?.(m) } catch {} }

    return async function onUtterance (utterance, reply) {
        try {
            if (!(await stt.available())) {
                log('[voice] STT unavailable — set config.voice.modelPath')
                reply?.done?.()
                return
            }
            // The on-device wake word already fired, so this utterance is
            // definitely addressed: light yellow NOW, before the (slow, ~10s on a
            // small host) transcription, so the leaf visibly "thinks" for the
            // whole STT run instead of going dark until the verdict. Deduped with
            // the post-transcription yellow below.
            let yellowShown = false
            if (utterance?.wake?.fired === true) {
                reply?.led?.('yellow')
                yellowShown = true
            }
            const { text, locale: detected } = await stt.transcribe({ ...utterance, locale })
            // Resolve which grammar(s) to parse against. With a real detected or
            // configured language, use just that. With 'auto' (whisper auto-detect,
            // no language hint), try ALL supported grammars and keep the best parse
            // — otherwise a non-English speaker's command parses under English and
            // is never recognized (the "red light" bug).
            const langs = detected && detected !== 'auto'
                ? [detected]
                : (locale && locale !== 'auto' ? [locale] : AUTO_LANGS)
            let intent = { intent: 'unknown', slots: {}, confidence: 0, raw: text }
            let lang = langs[0]
            for (const candidate of langs) {
                const parsed = parseIntent(text, candidate)
                if (parsed.intent !== 'unknown' && Number(parsed.confidence) > Number(intent.confidence)) {
                    intent = parsed
                    lang = candidate
                }
            }
            // Trust the ON-DEVICE wake word (microWakeWord) when the firmware
            // reports it fired: the STT often mis-transcribes the spoken "yo"
            // (e.g. as the Italian "io"), so a text-only detectWake would wrongly
            // gate a command the leaf already confirmed was addressed to it. Fall
            // back to text detection (any candidate language) for older firmware.
            const wake = utterance?.wake?.fired === true || langs.some((l) => detectWake(text, l))
            // Addressed = a wake word led the utterance, or it parses to a command
            // (covers STT mis-hearing the wake word but still getting the verb).
            // This drives the LED/parse milestones only; it does NOT decide whether
            // we write — see the write gate below.
            const addressed = wake || intent.intent !== 'unknown'
            if (!addressed) {
                log(`[voice] "${text}" -> ignored (no wake word / command)`)
                reply?.done?.()
                return
            }
            // 1) wake word recognized -> yellow (unless already lit pre-STT)
            if (!yellowShown) reply?.led?.('yellow')
            if (intent.intent === 'unknown') {
                // Addressed (the wake word fired) but the command was not
                // understood — e.g. speaking a language the STT model can't
                // transcribe (an English-only model hearing Italian). Flash red so
                // the failure is legible ("heard you, didn't understand") instead
                // of the leaf silently going dark after yellow.
                log(`[voice] "${text}" -> wake only (no command)`)
                await sleep(dwell.command)
                reply?.led?.('red')
                await sleep(dwell.fail)
                reply?.done?.()
                return
            }
            // 2) command recognized -> purple. Shown even when the write is gated,
            // so on-device debugging still proves the parse. No dwell sleep before
            // the write: transcription already finished above, so any sleep here is
            // pure latency between recognition and the item appearing. The leaf
            // still receives yellow -> purple -> green/red in order.
            reply?.led?.('purple')
            // WRITE GATE: the milestones above show the parse, but a likely false
            // positive (no wake word + below-floor confidence, e.g. an ambient
            // "please put the kettle on" -> add 0.6, or "take off your shoes" ->
            // remove 0.85) must NOT execute or reach green/save. Until a real
            // wake-word model exists, this is the line that stops ambient speech
            // from silently mutating lists.
            if (!shouldExecuteIntent(intent, { wake, floors })) {
                log(`[voice] "${text}" -> ${intent.intent} (conf ${intent.confidence}) gated: not addressed (no wake word, confidence below floor)`)
                await sleep(dwell.command)
                await sleep(dwell.fail)
                reply?.done?.()
                return
            }
            // 3) execute FIRST so the item exists ~700ms sooner, THEN play the
            // confirm color. A fast execute would overwrite purple within
            // milliseconds (making it invisible on the device — reported in the
            // field), so pad purple up to dwell.command before switching to the
            // verdict color. The item is already saved during the pad.
            const purpleAt = Date.now()
            const result = await controller.execute(intent)
            log(`[voice] "${text}" -> ${result.intent} (${result.code})`)
            const purpleElapsed = Date.now() - purpleAt
            if (purpleElapsed < dwell.command) await sleep(dwell.command - purpleElapsed)
            reply?.led?.(result.ok ? 'green' : 'red')
            await sleep(result.ok ? dwell.hold : dwell.fail)
            reply?.done?.()
        } catch (err) {
            log(`[ERROR] voice utterance failed: ${err?.message ?? err}`)
            try { reply?.led?.('red'); await sleep(dwell.fail); reply?.done?.() } catch {}
        }
    }
}
