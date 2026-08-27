import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DEFAULT_LOG_TAIL_CAPACITY,
    MAX_LOG_TAIL_CAPACITY,
    clearLogTail,
    configureLogTail,
    createLogger,
    logTail,
} from './index.mjs'

test.beforeEach(() => {
    configureLogTail({ capacity: DEFAULT_LOG_TAIL_CAPACITY })
    clearLogTail()
})

test('log tail keeps every logger line up to the capacity', () => {
    configureLogTail({ capacity: 4 })
    const log = createLogger({ app: 'test', write: () => {} })

    log.info('one')
    log.warn('two')
    log.error('three')

    const tail = logTail()
    assert.equal(tail.entries.length, 3)
    assert.equal(tail.buffered, 3)
    assert.equal(tail.dropped, 0)
    assert.equal(tail.capacity, 4)
    assert.deepEqual(tail.entries.map((line) => JSON.parse(line).message), ['one', 'two', 'three'])
    assert.deepEqual(tail.entries.map((line) => JSON.parse(line).level), ['info', 'warn', 'error'])
})

test('log tail bounds the buffer and counts dropped lines under overflow', () => {
    configureLogTail({ capacity: 3 })
    const log = createLogger({ app: 'test', write: () => {} })

    for (let i = 0; i < 10; i++) log.info(`line ${i}`)

    const tail = logTail()
    assert.equal(tail.entries.length, 3)
    assert.equal(tail.buffered, 3)
    assert.equal(tail.dropped, 7)
    // The ring must survive the wrap in order, newest last.
    assert.deepEqual(tail.entries.map((line) => JSON.parse(line).message), ['line 7', 'line 8', 'line 9'])
})

test('log tail limit returns the newest lines without counting them as dropped', () => {
    const log = createLogger({ app: 'test', write: () => {} })

    for (let i = 0; i < 6; i++) log.info(`line ${i}`)

    const tail = logTail({ limit: 2 })
    assert.deepEqual(tail.entries.map((line) => JSON.parse(line).message), ['line 4', 'line 5'])
    assert.equal(tail.buffered, 6)
    assert.equal(tail.dropped, 0)
    assert.equal(logTail({ limit: 0 }).entries.length, 0)
    assert.equal(logTail({ limit: 999 }).entries.length, 6)
})

test('log tail entries are redacted, so secrets never reach an exported bundle', () => {
    const hex = 'f'.repeat(64)
    const invite = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(2)
    const cardPayload = '9824516530999'
    const log = createLogger({ app: 'test', write: () => {} })

    log.error(`join failed for key=${hex}`)
    log.info('pairing', { invite, encryptionKey: hex })
    log.info(`scan barcode=${cardPayload}`)
    // redactForLog flattens an Error to {name, message}, so diagnostic context
    // rides as its own argument.
    log.error('join threw', new Error(`bad key ${hex}`), { attempt: 2, baseKey: hex })

    const serialized = JSON.stringify(logTail())
    assert.equal(serialized.includes(hex), false)
    assert.equal(serialized.includes(invite), false)
    assert.equal(serialized.includes(cardPayload), false)
    assert.ok(serialized.includes('[redacted-hex]'))

    // Non-secret diagnostic context has to survive, or the bundle is useless.
    const last = JSON.parse(logTail({ limit: 1 }).entries[0])
    assert.equal(last.message, 'join threw')
    assert.deepEqual(last.details[0], { name: 'Error', message: 'bad key [redacted-hex]' })
    assert.equal(last.details[1].attempt, 2)
    assert.equal(last.details[1].baseKey, '[redacted]')
})

test('log tail buffers in addition to the existing sink', () => {
    const written = []
    const log = createLogger({ app: 'test', write: (line) => written.push(line) })

    log.info('sink still fires')

    assert.equal(written.length, 1)
    assert.equal(JSON.parse(written[0]).message, 'sink still fires')
    assert.deepEqual(logTail().entries, written)
})

test('log tail buffers a line even when the sink throws', () => {
    const log = createLogger({
        app: 'test',
        write: () => { throw new Error('sink is gone') },
    })

    assert.throws(() => log.error('write failed'), /sink is gone/)
    assert.equal(JSON.parse(logTail().entries[0]).message, 'write failed')
})

test('log tail can be opted out per logger', () => {
    const written = []
    const log = createLogger({ app: 'test', tail: false, write: (line) => written.push(line) })

    log.info('not buffered')

    assert.equal(written.length, 1)
    assert.equal(logTail().buffered, 0)
    assert.equal(logTail().dropped, 0)
})

test('clearing the tail resets the buffer and the dropped counter', () => {
    configureLogTail({ capacity: 2 })
    const log = createLogger({ app: 'test', write: () => {} })

    for (let i = 0; i < 5; i++) log.info(`line ${i}`)
    assert.equal(logTail().dropped, 3)

    const stats = clearLogTail()
    assert.deepEqual(stats, { buffered: 0, dropped: 0, capacity: 2 })
    assert.deepEqual(logTail().entries, [])
})

test('shrinking the capacity evicts the oldest lines and reports them as dropped', () => {
    configureLogTail({ capacity: 10 })
    const log = createLogger({ app: 'test', write: () => {} })

    for (let i = 0; i < 6; i++) log.info(`line ${i}`)
    const stats = configureLogTail({ capacity: 2 })

    assert.deepEqual(stats, { buffered: 2, dropped: 4, capacity: 2 })
    assert.deepEqual(logTail().entries.map((line) => JSON.parse(line).message), ['line 4', 'line 5'])

    // The ring must still wrap correctly after the resize.
    log.info('line 6')
    assert.deepEqual(logTail().entries.map((line) => JSON.parse(line).message), ['line 5', 'line 6'])
    assert.equal(logTail().dropped, 5)
})

test('a zero capacity disables buffering but still counts what was lost', () => {
    configureLogTail({ capacity: 0 })
    const written = []
    const log = createLogger({ app: 'test', write: (line) => written.push(line) })

    log.info('dropped on the floor')

    assert.equal(written.length, 1)
    assert.deepEqual(logTail(), { entries: [], buffered: 0, dropped: 1, capacity: 0 })
})

test('an unbounded capacity request is clamped, never granted', () => {
    // Asking for "everything" on a phone must not turn the ring into a leak — and
    // must not fall through to 0 either, which is what silently killed the tail.
    assert.equal(configureLogTail({ capacity: Infinity }).capacity, MAX_LOG_TAIL_CAPACITY)
    assert.equal(configureLogTail({ capacity: MAX_LOG_TAIL_CAPACITY * 10 }).capacity, MAX_LOG_TAIL_CAPACITY)
})

test('a capacity that is not a number is refused instead of disabling the tail', () => {
    configureLogTail({ capacity: 4 })
    const log = createLogger({ app: 'test', write: () => {} })
    log.info('keep me')

    for (const bad of ['oops', NaN, {}, null]) {
        assert.throws(() => configureLogTail({ capacity: bad }), TypeError)
    }

    // The refusal must leave the buffer exactly as it was.
    assert.deepEqual(logTail().entries.map((line) => JSON.parse(line).message), ['keep me'])
    assert.equal(logTail().capacity, 4)
    assert.equal(logTail().dropped, 0)
})

test('a limit that is not a number returns the whole tail, not an empty bundle', () => {
    const log = createLogger({ app: 'test', write: () => {} })
    for (let i = 0; i < 3; i++) log.info(`line ${i}`)

    // null is what a UI or an RPC payload sends for "no limit given"; coercing it
    // to 0 would hand back an empty bundle for the one call that must not be empty.
    assert.equal(logTail({ limit: null }).entries.length, 3)
    assert.equal(logTail({ limit: NaN }).entries.length, 3)
    assert.equal(logTail({ limit: 'all' }).entries.length, 3)
    assert.equal(logTail({ limit: Infinity }).entries.length, 3)
})

test('credentials never survive into an exportable bundle', () => {
    // The tail is copied off-device and pasted into chats, so this is the
    // difference between a diagnostic and a credential leak. `password` and
    // `secret` were NOT in SENSITIVE_KEYS while logs only went to a terminal.
    clearLogTail()
    const log = createLogger({ app: 'redaction-check' })
    log.log('[INFO] backup configured', {
        password: 'hunter2',
        nextPassword: 'hunter3',
        passphrase: 'correct horse',
        secret: 'shh',
        seed: 'abandon abandon abandon',
        encryptionKey: 'deadbeef',
    })

    const bundle = JSON.stringify(logTail({}))
    for (const leaked of ['hunter2', 'hunter3', 'correct horse', 'shh', 'abandon abandon', 'deadbeef']) {
        assert.equal(bundle.includes(leaked), false, `${leaked} must not reach an exported bundle`)
    }
    assert.ok(bundle.includes('[redacted]'))
})
