/**
 * The smallest markdown renderer the PRD, roadmap and docs views need — and no more.
 *
 * The safety rule is the first line of the algorithm: every character of the source is
 * HTML-escaped *before* anything else looks at it, so the only angle brackets in the output are
 * the ones this file writes itself. There is no raw-HTML passthrough, and there is no
 * configuration to turn one on. Link targets are then filtered to `http:`, `https:`, a fragment
 * or a site-absolute path; anything else (`javascript:`, `data:`, a bare word) renders as the
 * literal text the author typed rather than becoming a clickable thing.
 *
 * Supported, deliberately: ATX headings h1–h4, fenced code, inline code, bold/italic, unordered
 * and ordered lists with one level of nesting, blockquotes, horizontal rules, simple pipe tables
 * and links. Everything else is a paragraph.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** The one gate: `& < > "` never reach the output as themselves. */
export function escapeHtml(src: string): string {
  return src.replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/**
 * The only link targets that become an `<a>`: the web, this page, or this site. The
 * `(?![\/\\])` is the difference between a site-absolute path and `//somewhere-else` or
 * `/\somewhere-else` — both of which a browser resolves as a link off-site wearing a path's
 * clothes, since a backslash after a leading slash is treated the same as another slash.
 */
const SAFE_URL = /^(?:https?:|#|\/(?![\/\\]))/;

/**
 * The `id` a heading gets, and the anchor an audit chip scrolls to. Entities are dropped rather
 * than transliterated so the escaped heading `Goals &amp; scope` and the hub's raw `Goals & scope`
 * land on the same id.
 */
export function headingId(text: string): string {
  const slug = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `md-${slug}` : 'md-section';
}

/**
 * A `path:line` code span — `packages/hub/src/server.ts:412` — as the guide and the code map write
 * them (FR-B4, FR-B5). An extension is required so ordinary prose in backticks (`Note:12`, `a:b`)
 * stays a code span, and so does a bare word with a colon in it.
 */
const CODE_REF = /^([A-Za-z0-9._\-/]+\.[A-Za-z0-9]+):([0-9]{1,7})$/;

/**
 * The file and line a code span points at, or null when it points at nothing. Pure, and it runs on
 * *escaped* text — the same text the span will render as — so what the link carries is exactly
 * what the reader sees.
 */
export function codeRef(text: string): { path: string; line: number } | null {
  const match = CODE_REF.exec(text);
  return match ? { path: match[1], line: Number(match[2]) } : null;
}

/**
 * A code span, turned into a link when it names a file and a line. No `href`: it opens the Code
 * screen's viewer, which reads `data-path`/`data-line` — an anchor with nowhere to navigate would
 * be a broken link in every other context this markdown is rendered in.
 */
function codeSpan(escaped: string): string {
  const ref = codeRef(escaped);
  if (!ref) return `<code>${escaped}</code>`;
  return `<a class="md__ref" data-path="${ref.path}" data-line="${ref.line}"><code>${escaped}</code></a>`;
}

// Inline spans, in precedence order: code first (nothing formats inside it), then links, then the
// two emphasis pairs. `_` needs word boundaries or `snake_case_names` would sprout italics.
// A fresh regex per call, because `inline` recurses and a shared `lastIndex` would never finish.
const INLINE =
  '`([^`]+)`|\\[([^\\]]*)\\]\\(([^()\\s]*)\\)|\\*\\*([\\s\\S]+?)\\*\\*|(?<![A-Za-z0-9])__([\\s\\S]+?)__(?![A-Za-z0-9])|\\*([\\s\\S]+?)\\*|(?<![A-Za-z0-9])_([\\s\\S]+?)_(?![A-Za-z0-9])';

const MAX_INLINE_DEPTH = 3;

/** Inline formatting over text that is *already escaped*. Never call it with raw source. */
function inline(text: string, depth = 0): string {
  if (depth > MAX_INLINE_DEPTH) return text;
  let out = '';
  let last = 0;
  const spans = new RegExp(INLINE, 'g');
  for (let match = spans.exec(text); match; match = spans.exec(text)) {
    out += text.slice(last, match.index);
    last = match.index + match[0].length;
    const [whole, code, linkText, url, strongStar, strongBar, emStar, emBar] = match;
    if (code !== undefined) out += codeSpan(code);
    else if (url !== undefined) {
      // An unsafe or unrecognised target keeps its source spelling — visible, inert, honest.
      out += SAFE_URL.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${inline(linkText, depth + 1)}</a>`
        : whole;
    } else if (strongStar !== undefined || strongBar !== undefined) {
      out += `<strong>${inline((strongStar ?? strongBar)!, depth + 1)}</strong>`;
    } else {
      out += `<em>${inline((emStar ?? emBar)!, depth + 1)}</em>`;
    }
  }
  return out + text.slice(last);
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})[ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}&gt;[ \t]?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;

function ordered(bullet: string): boolean {
  return !/^[-*+]$/.test(bullet);
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

/** True where `line` would start some other block, so a paragraph must stop before it. */
function startsBlock(line: string, next: string | undefined): boolean {
  return !line.trim()
    || FENCE.test(line) || HEADING.test(line) || RULE.test(line)
    || QUOTE.test(line) || LIST_ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_RULE.test(next));
}

interface ListItem { text: string; sub: string[]; subOrdered: boolean }

/** A list and — at most — one level nested under it, consumed from `at`. */
function takeList(lines: string[], at: number): { html: string; next: number } {
  const first = LIST_ITEM.exec(lines[at])!;
  const kind = ordered(first[2]);
  const base = first[1].length;
  const items: ListItem[] = [];
  let index = at;

  while (index < lines.length) {
    // One blank line between items is still one list; two ends it, as does anything else.
    if (!lines[index].trim()) {
      if (index + 1 < lines.length && LIST_ITEM.test(lines[index + 1])) { index++; continue; }
      break;
    }
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) {
      // A hard-wrapped item: a line that starts no block of its own continues the item above it
      // (its last sub-item, when it has some), the way every markdown reader treats it.
      if (!items.length || startsBlock(lines[index], lines[index + 1])) break;
      const last = items[items.length - 1];
      const line = lines[index].trim();
      if (last.sub.length) last.sub[last.sub.length - 1] += ` ${line}`;
      else last.text += ` ${line}`;
      index++;
      continue;
    }
    const indent = match[1].length;
    const itemKind = ordered(match[2]);
    if (indent <= base) {
      if (itemKind !== kind) break;
      items.push({ text: match[3], sub: [], subOrdered: false });
    } else {
      if (!items.length) break;
      const last = items[items.length - 1];
      if (!last.sub.length) last.subOrdered = itemKind;
      last.sub.push(match[3]);
    }
    index++;
  }

  const body = items.map((item) => {
    const nested = item.sub.length
      ? `<${item.subOrdered ? 'ol' : 'ul'}>${item.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</${item.subOrdered ? 'ol' : 'ul'}>`
      : '';
    return `<li>${inline(item.text)}${nested}</li>`;
  }).join('');

  return { html: `<${kind ? 'ol' : 'ul'}>${body}</${kind ? 'ol' : 'ul'}>`, next: index };
}

function takeTable(lines: string[], at: number): { html: string; next: number } {
  const head = cells(lines[at]);
  const body: string[][] = [];
  let index = at + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
    body.push(cells(lines[index]));
    index++;
  }
  const headRow = `<tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>`;
  const rows = body
    .map((row) => `<tr>${head.map((_, column) => `<td>${inline(row[column] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return { html: `<table><thead>${headRow}</thead><tbody>${rows}</tbody></table>`, next: index };
}

/** Markdown → HTML that is safe to assign to `innerHTML`. */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index++; continue; }

    if (FENCE.test(line)) {
      const code: string[] = [];
      index++;
      // An unclosed fence swallows the rest of the document — as code, not as markup.
      while (index < lines.length && !FENCE.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      out.push(`<h${level} id="${headingId(text)}">${inline(text)}</h${level}>`);
      index++;
      continue;
    }

    if (RULE.test(line)) { out.push('<hr>'); index++; continue; }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]);
        if (!match) break;
        quoted.push(match[1]);
        index++;
      }
      out.push(`<blockquote>${inline(quoted.join(' ').trim())}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = takeList(lines, index);
      out.push(list.html);
      index = list.next;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      const table = takeTable(lines, index);
      out.push(table.html);
      index = table.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines[index], lines[index + 1])) {
      paragraph.push(lines[index].trim());
      index++;
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return out.join('\n');
}

/* --- documentation extras ---------------------------------------------------
 *
 * Everything below is additive: `renderMarkdown` above is untouched, and a caller that wants the
 * plain renderer still gets exactly it. The docs shell calls `renderDocMarkdown` instead, which
 * understands one block the plain renderer does not — the Docusaurus-style admonition:
 *
 *     :::warning Don't do this
 *     Body markdown.
 *     :::
 *
 * The block is peeled off the source *before* anything is rendered, and its body is then handed to
 * `renderMarkdown` like any other document, so the escape-first rule holds unchanged: no raw HTML
 * reaches the output, and the only markup around the body is the wrapper this file writes.
 */

export type AdmonitionKind = 'info' | 'tip' | 'note' | 'warning' | 'danger';

const ADMONITION_KINDS: AdmonitionKind[] = ['info', 'tip', 'note', 'warning', 'danger'];

const ADMONITION_LABELS: Record<AdmonitionKind, string> = {
  info: 'Info',
  tip: 'Tip',
  note: 'Note',
  warning: 'Warning',
  danger: 'Danger',
};

/**
 * One glyph per kind, drawn here rather than fetched: a circle for the neutral three, a triangle
 * for warning, an octagon for danger. `currentColor` throughout, so the label's colour carries the
 * icon with it.
 */
const ADMONITION_ICONS: Record<AdmonitionKind, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5v5"/><path d="M12 7.6h.01"/>',
  tip: '<path d="M9.5 18h5"/><path d="M10.5 21h3"/><path d="M12 3a6 6 0 0 1 3.5 10.9c-.3.2-.5.6-.5 1V15H9v-.1c0-.4-.2-.8-.5-1A6 6 0 0 1 12 3z"/>',
  note: '<rect x="4.5" y="3" width="15" height="18" rx="2"/><path d="M8.5 8.5h7"/><path d="M8.5 12.5h7"/><path d="M8.5 16.5h4"/>',
  warning: '<path d="M12 4 2.9 20h18.2L12 4z"/><path d="M12 10.5v4"/><path d="M12 17.4h.01"/>',
  danger: '<path d="M8.6 3h6.8L20 7.6v6.8L15.4 19H8.6L4 14.4V7.6L8.6 3z"/><path d="M12 7.5v5"/><path d="M12 15.6h.01"/>',
};

/** A stretch of the source: either plain markdown, or one admonition and its body. */
export interface DocBlock {
  kind: AdmonitionKind | null;
  /** The heading an admonition wears; '' when the author gave none. Ignored when `kind` is null. */
  title: string;
  markdown: string;
}

const ADMONITION_OPEN = /^ {0,3}:::[ \t]*([a-z]+)[ \t]*(.*?)[ \t]*$/;
const ADMONITION_CLOSE = /^ {0,3}:::[ \t]*$/;

/**
 * Splits `src` into plain stretches and admonitions, in document order. Fenced code is stepped
 * over, so a `:::` inside a code block stays code, and an unclosed block runs to the end of the
 * document — the same forgiving rule the fence parser already uses. Pure; the renderer and its
 * test both go through it.
 */
export function splitCallouts(src: string): DocBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let plain: string[] = [];
  let fenced = false;

  const flush = (): void => {
    if (plain.join('\n').trim()) blocks.push({ kind: null, title: '', markdown: plain.join('\n') });
    plain = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) fenced = !fenced;
    const open = fenced ? null : ADMONITION_OPEN.exec(line);
    const kind = open?.[1] as AdmonitionKind | undefined;
    if (!open || !kind || !ADMONITION_KINDS.includes(kind)) { plain.push(line); continue; }

    flush();
    const body: string[] = [];
    let inner = false;
    index++;
    while (index < lines.length) {
      if (FENCE.test(lines[index])) inner = !inner;
      if (!inner && ADMONITION_CLOSE.test(lines[index])) break;
      body.push(lines[index]);
      index++;
    }
    blocks.push({ kind, title: open[2], markdown: body.join('\n') });
  }

  flush();
  return blocks;
}

/** Markdown → HTML, with `:::info` and its four siblings rendered as admonitions. */
export function renderDocMarkdown(src: string): string {
  return splitCallouts(src)
    .map((block) => {
      if (!block.kind) return renderMarkdown(block.markdown);
      const label = escapeHtml(block.title.trim() || ADMONITION_LABELS[block.kind]);
      const icon = '<svg class="adm__icon" viewBox="0 0 24 24" width="15" height="15" fill="none"'
        + ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
        + ` aria-hidden="true">${ADMONITION_ICONS[block.kind]}</svg>`;
      return `<aside class="adm adm--${block.kind}" role="note">`
        + `<p class="adm__head">${icon}<span>${label}</span></p>`
        + `<div class="adm__body">${renderMarkdown(block.markdown)}</div>`
        + '</aside>';
    })
    .join('\n');
}
