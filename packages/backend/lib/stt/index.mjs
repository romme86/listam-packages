// STT engine selector. One interface across host runtimes:
//   stt.available()  -> Promise<boolean>
//   stt.transcribe({ pcm, sampleRate, locale }) -> Promise<{ text, locale }>
//
// v1: 'whisper-cpp' on the Node headless host. 'qvac' (Bare worker) is added
// later. A 'fixture' engine (config.transcribe injected) keeps the voice
// pipeline end-to-end testable without a real model.

import { createWhisperCppStt } from './whisper-cpp-subprocess.mjs'

export function createStt ({ engine = 'whisper-cpp', config = {}, logger = null } = {}) {
    switch (engine) {
        case 'whisper-cpp':
            return createWhisperCppStt({ config, logger })
        case 'fixture':
            if (typeof config.transcribe !== 'function') throw new Error("fixture STT needs config.transcribe")
            return { engine: 'fixture', available: async () => true, transcribe: config.transcribe }
        case 'none':
        case 'disabled':
            return { engine: 'none', available: async () => false, transcribe: async () => { throw new Error('STT disabled') } }
        default:
            throw new Error(`unknown STT engine: ${engine}`)
    }
}
