import test from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeTableRows,
    tableAddRow,
    tableAddColumn,
    tableRemoveRow,
    tableRemoveColumn,
    createBlock,
    blockToText,
    blockFromText,
} from './board.mjs'

test('normalizeTableRows squares off ragged / empty / non-string grids', () => {
    // Ragged rows pad to the widest row.
    assert.deepEqual(
        normalizeTableRows([['a'], ['b', 'c', 'd'], ['e', 'f']]),
        [['a', '', ''], ['b', 'c', 'd'], ['e', 'f', '']],
    )
    // Empty / missing rows fall back to a 2x2 blank grid.
    assert.deepEqual(normalizeTableRows([]), [['', ''], ['', '']])
    assert.deepEqual(normalizeTableRows(null), [['', ''], ['', '']])
    assert.deepEqual(normalizeTableRows(undefined), [['', ''], ['', '']])
    // Non-string cells coerce to strings; a row must have at least one column.
    assert.deepEqual(normalizeTableRows([[1, null, 'x'], []]), [['1', '', 'x'], ['', '', '']])
    assert.deepEqual(normalizeTableRows([[]]), [['']])
})

test('normalizeTableRows preserves commas inside a cell (no text-channel split)', () => {
    const grid = [['City', 'Budget'], ['Tokyo', 'CHF 1,200']]
    assert.deepEqual(normalizeTableRows(grid), grid)
})

test('tableAddRow appends a blank row of the right width', () => {
    assert.deepEqual(tableAddRow([['a', 'b'], ['c', 'd']]), [['a', 'b'], ['c', 'd'], ['', '']])
    // Widens a ragged input first, so the appended row matches.
    assert.deepEqual(tableAddRow([['a', 'b', 'c']]), [['a', 'b', 'c'], ['', '', '']])
})

test('tableAddColumn appends a blank cell to every row', () => {
    assert.deepEqual(tableAddColumn([['a', 'b'], ['c', 'd']]), [['a', 'b', ''], ['c', 'd', '']])
})

test('tableRemoveRow drops the row but keeps at least one', () => {
    assert.deepEqual(tableRemoveRow([['h1', 'h2'], ['a', 'b'], ['c', 'd']], 1), [['h1', 'h2'], ['c', 'd']])
    // Deleting the header promotes the next row.
    assert.deepEqual(tableRemoveRow([['h1', 'h2'], ['a', 'b']], 0), [['a', 'b']])
    // Refuses to delete the last remaining row, or an out-of-range index.
    assert.deepEqual(tableRemoveRow([['only']], 0), [['only']])
    assert.deepEqual(tableRemoveRow([['a'], ['b']], 5), [['a'], ['b']])
    assert.deepEqual(tableRemoveRow([['a'], ['b']], -1), [['a'], ['b']])
})

test('tableRemoveColumn drops the column but keeps at least one', () => {
    assert.deepEqual(tableRemoveColumn([['h1', 'h2', 'h3'], ['a', 'b', 'c']], 1), [['h1', 'h3'], ['a', 'c']])
    // Refuses to delete the last remaining column, or an out-of-range index.
    assert.deepEqual(tableRemoveColumn([['a'], ['b']], 0), [['a'], ['b']])
    assert.deepEqual(tableRemoveColumn([['a', 'b']], 9), [['a', 'b']])
})

test('a freshly-created table block normalizes to its own 2x2 grid', () => {
    const block = createBlock('table', 't1')
    assert.deepEqual(normalizeTableRows(block.rows), [['', ''], ['', '']])
})

test('a table cell with a comma survives the text channel round-trip', () => {
    // A grid-authored cell like "CHF 1,200" must NOT split into two cells when a
    // peer edits the table through the comma-delimited blockToText/blockFromText.
    const rows = [['City', 'Budget'], ['Tokyo', 'CHF 1,200'], ['Kyoto', 'CHF 900']]
    const text = blockToText({ type: 'table', rows })
    assert.deepEqual(blockFromText('table', text).rows, rows)
    // A literal backslash in a cell also round-trips.
    const back = [['a\\b', 'c,d'], ['e', 'f']]
    assert.deepEqual(blockFromText('table', blockToText({ type: 'table', rows: back })).rows, back)
})

test('no-comma tables and legacy comma text parse exactly as before', () => {
    // Output format for comma-free cells is unchanged (comma+space separator).
    assert.equal(blockToText({ type: 'table', rows: [['A', 'B'], ['1', '2']] }), 'A, B\n1, 2')
    // Legacy raw-comma text (no escaping) still splits per cell.
    assert.deepEqual(blockFromText('table', 'A, B\n1, 2').rows, [['A', 'B'], ['1', '2']])
})
