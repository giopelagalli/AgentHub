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
    if (code !== undefined) out += `<code>${code}</code>`;
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
    if (!match) break;
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
