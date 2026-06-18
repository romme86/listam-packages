// Shared, pure, dependency-free markdown <-> HTML bridge for the app's
// whitelisted inline subset — **bold**, *italic*, `code`, [label](url) (http/
// https/mailto only) — plus #/##/### headings (1-6 accepted; 4-6 collapse onto
// h3, matching the desktop/mobile view renderers).
//
// Both editors are WYSIWYG: they seed from markdownToHtml(...) so the user only
// ever sees compiled markdown, and serialize back with htmlToMarkdown(...) so
// markdown stays the single stored representation. htmlToMarkdown is purely
// string-based (no DOM / DOMParser) so it runs unchanged in React Native too.
//
// markdownToHtml emits a clean block model — one <p> (or <h1..3>) per source
// line — that round-trips losslessly and that both contentEditable (Chromium)
// and TipTap/ProseMirror (the mobile webview) treat as native block nodes.

const SAFE_LINK = /^(https?:\/\/|mailto:)/i
// Private placeholder used only inside inlineMarkdownToHtml to stash code-span
// bodies while the other inline passes run. NUL never survives the function.
const TOKEN = String.fromCharCode(0)

export function escapeHtml (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ))
}

// Inline markdown -> safe inline HTML. Escapes first, then layers the subset, so
// the result is always built from escaped text and is safe to assign to
// innerHTML. Anchors carry href only (no target/rel) to keep them trivial to
// round-trip; the editors don't navigate on click anyway.
export function inlineMarkdownToHtml (text) {
    let out = escapeHtml(text).split(TOKEN).join('') // strip any stray NUL first
    // Tokenize code spans FIRST and stash their bodies, so markdown markers
    // inside `code` stay literal and are not re-interpreted by the bold/italic/
    // link passes below (e.g. `a*b*c` must keep its literal asterisks).
    const codes = []
    out = out.replace(/`([^`]+)`/g, (_m, code) => `${TOKEN}${codes.push(code) - 1}${TOKEN}`)
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`)
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, em) => `${pre}<em>${em}</em>`)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
        // url is already HTML-escaped here; validate the decoded scheme.
        const decoded = url.replace(/&amp;/g, '&')
        if (!SAFE_LINK.test(decoded)) return match
        return `<a href="${url}">${label}</a>`
    })
    out = out.replace(new RegExp(`${TOKEN}(\\d+)${TOKEN}`, 'g'), (_m, i) => `<code>${codes[Number(i)]}</code>`)
    return out
}

// Block-level markdown -> safe HTML. One block element per source line:
// #/##/### -> <h1..3>, blank line -> empty <p>, anything else -> <p>inline</p>.
export function markdownToHtml (text) {
    const lines = String(text == null ? '' : text).split('\n')
    let out = ''
    for (const line of lines) {
        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
            const level = Math.min(heading[1].length, 3)
            out += `<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`
        } else if (line === '') {
            out += '<p></p>'
        } else {
            out += `<p>${inlineMarkdownToHtml(line)}</p>`
        }
    }
    return out || '<p></p>'
}

function decodeEntities (s) {
    // Decode &amp; LAST so a literal "&lt;" (stored as "&amp;lt;") survives.
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x0*27;/gi, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
}

// A private sentinel (never appears in user text — any pre-existing copy is
// stripped at the top of htmlToMarkdown) marking an intentional blank line
// through the newline-collapsing step below.
const BLANK = String.fromCharCode(1)

// HTML -> markdown for the whitelisted subset, tolerant of what either editor
// emits: contentEditable (<div>/<p>/<br>, <b>/<strong>, <i>/<em>, <code>, <a>,
// <h1..6>, &nbsp;) and TipTap/ProseMirror (<p>, <h1..3>, <strong>, <em>,
// <code>, <a>, and <br class="ProseMirror-trailingBreak">). Pure string
// transforms (no DOM) so it runs in React Native.
//
// Model: every line is a block element; adjacent blocks join with a single
// newline; an *empty* block is the only thing that yields a blank line. So we
// unify all blocks to <p>, stamp empty paragraphs with a sentinel (the real
// blank lines), turn block boundaries into newlines, collapse the runs that
// adjacency produces down to one, then re-expand the sentinels.
export function htmlToMarkdown (html) {
    // Strip any pre-existing sentinel char so it can never collide with ours.
    let s = String(html == null ? '' : html).split(BLANK).join('')
    // 1) Inline emphasis/code -> markers (before blocks, so bodies keep markers).
    s = s
        .replace(/<\s*(?:strong|b)\s*>/gi, '**').replace(/<\s*\/\s*(?:strong|b)\s*>/gi, '**')
        .replace(/<\s*(?:em|i)\s*>/gi, '*').replace(/<\s*\/\s*(?:em|i)\s*>/gi, '*')
        .replace(/<\s*code\s*>/gi, '`').replace(/<\s*\/\s*code\s*>/gi, '`')
    // 2) Anchors -> [label](url) when the scheme is safe, else just the label.
    s = s.replace(/<a\b[^>]*?href\s*=\s*("|')(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, url, label) => {
        const decoded = url.replace(/&amp;/g, '&')
        return SAFE_LINK.test(decoded) ? `[${label}](${decoded})` : label
    })
    // 3) Headings -> #-prefixed paragraphs (4-6 collapse onto ###, like the views).
    s = s.replace(/<\s*h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl, c) => (
        `<p>${'#'.repeat(Math.min(Number(lvl), 3))} ${c.trim()}</p>`
    ))
    // 4) Normalize <div> lines to <p>, then stamp empty paragraphs as blanks.
    //    <br> may carry attributes (TipTap's ProseMirror-trailingBreak class).
    s = s.replace(/<\s*div\b[^>]*>/gi, '<p>').replace(/<\s*\/\s*div\s*>/gi, '</p>')
    s = s.replace(/<\s*p\b[^>]*>\s*(?:<\s*br\b[^>]*>\s*)?<\s*\/\s*p\s*>/gi, BLANK)
    // 5) Remaining block boundaries + <br> -> newlines.
    s = s.replace(/<\s*p\b[^>]*>/gi, '\n').replace(/<\s*\/\s*p\s*>/gi, '\n')
    s = s.replace(/<\s*br\b[^>]*>/gi, '\n')
    // 6) Drop any leftover tags (defensive), decode entities.
    s = s.replace(/<\/?[a-z][^>]*>/gi, '')
    s = decodeEntities(s)
    // 7) Collapse adjacency runs to a single newline, then expand blanks back.
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n+/g, '\n')
    s = s.split(BLANK).join('')
    // 8) Drop editor artifacts (zero-width caret anchors, BOM), collapse 3+
    //    newlines to a blank line, trim ends.
    s = s.replace(/[\u200b\uFEFF]/g, '');
    s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
    return s
}
