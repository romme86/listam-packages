import test from 'node:test'
import assert from 'node:assert/strict'
import {
    detectDominantLanguage,
    getCategoryForItem,
    groupByCategory,
} from './index.mjs'

test('grocery category lookup handles multilingual exact and modifier matches', () => {
    assert.equal(getCategoryForItem('canned tuna'), 'Canned Goods')
    assert.equal(getCategoryForItem('fresh organic spinach'), 'Health & Organic')
    assert.equal(getCategoryForItem('red curry paste'), 'International Foods')
    assert.equal(getCategoryForItem('胡椒'), 'Condiments & Spices')
    assert.equal(getCategoryForItem('burrata'), 'Dairy')
})

test('grocery grouping detects dominant language and sorts active items first', () => {
    const sections = groupByCategory([
        { text: 'mela', isDone: true },
        { text: 'latte', isDone: false },
        { text: 'pane', isDone: false },
    ])

    assert.equal(detectDominantLanguage(['mela', 'latte', 'pane']), 'it')
    assert.deepEqual(sections.map((section) => section.canonicalKey), ['Fruits', 'Bread & Bakery', 'Dairy'])
    assert.equal(sections[0].category, 'Frutta')
    assert.equal(groupByCategory([{ text: 'mela', isDone: false }], 'es')[0].category, 'Frutas')
})
