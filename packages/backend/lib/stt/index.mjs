// STT engine selector. One interface across host runtimes:
//   stt.available()  -> Promise<boolean>
//   stt.transcribe({ pcm, sampleRate, locale }) -> Promise<{ text, locale }>
//
// 'whisper-cpp' on the Node headless host. 'whisper-bare' on the desktop Pear
// worker (same whisper-cli, spawned via injected bare-subprocess/bare-fs). A
// 'fixture' engine (config.transcribe injected) keeps the voice pipeline
// end-to-end testable without a real model. `runtime` carries the Bare modules
// the worker injects ({ subprocess, fs, tmpDir }); ignored by the Node engine.

import { createWhisperCppStt } from './whisper-cpp-subprocess.mjs'
import { createWhisperBareStt } from './bare-whisper.mjs'

export function createStt ({ engine = 'whisper-cpp', config = {}, logger = null, runtime = {} } = {}) {
    switch (engine) {
        case 'whisper-cpp':
            return createWhisperCppStt({ config, logger })
        case 'whisper-bare':
            return createWhisperBareStt({ config, logger, ...runtime })
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
