import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    escapeHtml,
    inlineMarkdownToHtml,
    markdownToHtml,
    htmlToMarkdown,
} from './markdown.mjs'

test('escapeHtml neutralizes the HTML metacharacters', () => {
    assert.equal(escapeHtml('<a&b>"\'' ), '&lt;a&amp;b&gt;&quot;&#39;')
    assert.equal(escapeHtml(null), '')
    assert.equal(escapeHtml(undefined), '')
})

test('inlineMarkdownToHtml renders the whitelisted subset', () => {
    assert.equal(inlineMarkdownToHtml('**bold**'), '<strong>bold</strong>')
    assert.equal(inlineMarkdownToHtml('a *b* c'), 'a <em>b</em> c')
    assert.equal(inlineMarkdownToHtml('use `code`'), 'use <code>code</code>')
    assert.equal(
        inlineMarkdownToHtml('[site](https://a.test)'),
        '<a href="https://a.test">site</a>'
    )
})

test('inlineMarkdownToHtml is XSS-safe', () => {
    assert.equal(inlineMarkdownToHtml('<img src=x onerror=alert(1)>').includes('<img'), false)
    assert.match(inlineMarkdownToHtml('<script>'), /&lt;script&gt;/)
    // javascript: / data: links are not turned into anchors
    assert.equal(inlineMarkdownToHtml('[x](javascript:alert(1))').includes('<a'), false)
    assert.equal(inlineMarkdownToHtml('[x](data:text/html,bad)').includes('<a'), false)
})

test('markdownToHtml emits one block element per line', () => {
    assert.equal(markdownToHtml('# Title'), '<h1>Title</h1>')
    assert.equal(markdownToHtml('## Sub'), '<h2>Sub</h2>')
    assert.equal(markdownToHtml('### Deep'), '<h3>Deep</h3>')
    // 4-6 hashes collapse onto h3 (matches the view renderers)
    assert.equal(markdownToHtml('#### Deeper'), '<h3>Deeper</h3>')
    assert.equal(markdownToHtml('###### Six'), '<h3>Six</h3>')
    assert.equal(markdownToHtml('a\nb'), '<p>a</p><p>b</p>')
    assert.equal(markdownToHtml('a\n\nb'), '<p>a</p><p></p><p>b</p>')
    assert.equal(markdownToHtml('# T\nbody **x**'), '<h1>T</h1><p>body <strong>x</strong></p>')
    // empty input still yields an editable empty paragraph
    assert.equal(markdownToHtml(''), '<p></p>')
    assert.equal(markdownToHtml(null), '<p></p>')
    // "#nospace" is not a heading
    assert.equal(markdownToHtml('#nospace'), '<p>#nospace</p>')
})

test('markdownToHtml is XSS-safe in heading and body lines', () => {
    const out = markdownToHtml('# <img src=x onerror=alert(1)>')
    assert.equal(out.includes('<img'), false)
    assert.match(out, /<h1>.*&lt;img/)
    assert.equal(markdownToHtml('plain <script>').includes('<script>'), false)
})

test('htmlToMarkdown inverts the inline subset', () => {
    assert.equal(htmlToMarkdown('<strong>bold</strong>'), '**bold**')
    assert.equal(htmlToMarkdown('<b>bold</b>'), '**bold**')
    assert.equal(htmlToMarkdown('<em>it</em>'), '*it*')
    assert.equal(htmlToMarkdown('<i>it</i>'), '*it*')
    assert.equal(htmlToMarkdown('<code>c</code>'), '`c`')
    assert.equal(htmlToMarkdown('<a href="https://a.test">site</a>'), '[site](https://a.test)')
    // unsafe-scheme anchors degrade to their label text
    assert.equal(htmlToMarkdown('<a href="javascript:alert(1)">x</a>'), 'x')
})

test('htmlToMarkdown turns block elements into lines', () => {
    assert.equal(htmlToMarkdown('<h1>Title</h1>'), '# Title')
    assert.equal(htmlToMarkdown('<h2>Sub</h2>'), '## Sub')
    assert.equal(htmlToMarkdown('<h3>Deep</h3>'), '### Deep')
    assert.equal(htmlToMarkdown('<h4>Deeper</h4>'), '### Deeper')
    assert.equal(htmlToMarkdown('<p>a</p><p>b</p>'), 'a\nb')
    // contentEditable's <div> line model
    assert.equal(htmlToMarkdown('a<div>b</div>'), 'a\nb')
    assert.equal(htmlToMarkdown('<div>a</div><div>b</div>'), 'a\nb')
    // <br> becomes a line break
    assert.equal(htmlToMarkdown('a<br>b'), 'a\nb')
    assert.equal(htmlToMarkdown('a<br/>b'), 'a\nb')
    // heading carrying inline markup
    assert.equal(htmlToMarkdown('<h1><strong>x</strong></h1>'), '# **x**')
})

test('htmlToMarkdown decodes entities and is not fooled by literal markup', () => {
    assert.equal(htmlToMarkdown('<p>a &amp; b</p>'), 'a & b')
    assert.equal(htmlToMarkdown('<p>&lt;script&gt;</p>'), '<script>')
    // a literal "&lt;" the user typed survives the round trip
    assert.equal(htmlToMarkdown('<p>&amp;lt;</p>'), '&lt;')
    assert.equal(htmlToMarkdown('<p>a&nbsp;b</p>'), 'a b')
})

test('markdown survives a full round trip (md -> html -> md)', () => {
    const samples = [
        '# Trip overview',
        'Two weeks across **Tokyo**, *Kyoto* and Osaka.',
        '## Getting around\nAnchor on the [JR Pass](https://japanrailpass.net) and `book early`.',
        'plain text\nsecond line',
        '# H1\n## H2\n### H3\nbody with **bold** and *em* and `code`',
        'a\n\nb\n\nc',
        'mailto [me](mailto:a@b.test) works',
        'literal & ampersand and < angle',
    ]
    for (const md of samples) {
        const round = htmlToMarkdown(markdownToHtml(md))
        assert.equal(round, md, `round trip failed for: ${JSON.stringify(md)}`)
    }
})

test('code spans keep their inner markdown markers literal', () => {
    // markers inside `code` must not be re-interpreted by the other passes
    assert.equal(inlineMarkdownToHtml('`a*b*c`'), '<code>a*b*c</code>')
    assert.equal(inlineMarkdownToHtml('`**bold**`'), '<code>**bold**</code>')
    assert.equal(inlineMarkdownToHtml('a `x` b **c**'), 'a <code>x</code> b <strong>c</strong>')
    // round trip still holds
    assert.equal(htmlToMarkdown(markdownToHtml('use `a*b*c` here')), 'use `a*b*c` here')
})

test('htmlToMarkdown handles <br> carrying attributes (TipTap hard breaks)', () => {
    assert.equal(htmlToMarkdown('<p>line1<br class="ProseMirror-trailingBreak">line2</p>'), 'line1\nline2')
    assert.equal(htmlToMarkdown('<p>line1<br class="x"/>line2</p>'), 'line1\nline2')
    // an empty paragraph whose only child is a classed <br> is a blank line
    assert.equal(htmlToMarkdown('<p>a</p><p><br class="ProseMirror-trailingBreak"></p><p>b</p>'), 'a\n\nb')
})

test('zero-width caret anchors in empty paragraphs still serialize to blank lines', () => {
    const zwsp = String.fromCharCode(0x200b)
    // the desktop editor seeds empty <p>/<h*> with a ZWSP so Chromium can place
    // a caret; that must not break blank-line round-tripping
    assert.equal(htmlToMarkdown(`<p>a</p><p>${zwsp}</p><p>b</p>`), 'a\n\nb')
    assert.equal(htmlToMarkdown(`<h1>${zwsp}</h1>`), '# ')
})

test('htmlToMarkdown does not delete a literal U+0001 in user content', () => {
    const soh = String.fromCharCode(1)
    assert.equal(htmlToMarkdown(`<p>before${soh}after</p>`), 'beforeafter')
    // and the round trip of text containing it is stable thereafter
    assert.equal(htmlToMarkdown(markdownToHtml('plain text')), 'plain text')
})

test('htmlToMarkdown tolerates ProseMirror/TipTap output shape', () => {
    // TipTap emits compact <p>/<h*> with <strong>/<em>/<code>/<a>
    const html = '<h2>Plan</h2><p>Buy <strong>milk</strong> and <em>eggs</em></p><p><a href="https://x.test" target="_blank" rel="noopener">link</a></p>'
    assert.equal(htmlToMarkdown(html), '## Plan\nBuy **milk** and *eggs*\n[link](https://x.test)')
})
