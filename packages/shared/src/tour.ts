/**
 * The tour (FR-B6), as pure functions both halves share: which steps a code map makes, and which
 * lines of a file one step shows. The hub uses them to decide what to explain and what to cache
 * against; the UI uses the very same ones to draw the step before the explanation has arrived, so
 * the snippet on screen is always the snippet that was explained.
 *
 * Browser-safe (no node imports) — it is bundled into the UI.
 */

/** One stop on the tour: a `path:line` reference from the code map, in the order the map reads. */
export interface TourStep {
  path: string;
  line: number;
  /** The map item's own words, with the reference taken out. */
  title: string;
}

/** The lines one step shows: 1-based and inclusive, with the text of exactly those lines. */
export interface TourSnippet {
  from: number;
  to: number;
  text: string;
}

/** The longest snippet a step shows; a function longer than this is shown from its start. */
export const SNIPPET_MAX_LINES = 60;

/** The same `path:line` shape the markdown renderer links (decision 0046): an extension is required. */
const CODE_REF = /^([A-Za-z0-9._\-/]+\.[A-Za-z0-9]+):([0-9]{1,7})$/;
const CODE_SPAN = /`([^`\n]+)`/g;
const FENCE = /^\s*(```|~~~)/;

/** An item's text once its reference, list marker and emphasis are gone. */
function titleOf(line: string, ref: string): string {
  return line
    .replace(`\`${ref}\``, '')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*/g, '')
    .replace(/^[\s—–:,-]+|[\s—–:,-]+$/g, '')
    .trim();
}

/**
 * Every `path:line` code span in the map, top to bottom, as a step. The map is written in reading
 * order (entry points first), so document order *is* the tour's order. A reference that appears
 * twice is visited once, where it first appears; fenced code blocks are skipped, since a span
 * there is an example, not a link.
 */
export function tourSteps(markdown: string): TourStep[] {
  const steps: TourStep[] = [];
  const seen = new Set<string>();
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const match of line.matchAll(CODE_SPAN)) {
      const ref = CODE_REF.exec(match[1]);
      if (!ref) continue;
      const key = match[1];
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ path: ref[1], line: Number(ref[2]), title: titleOf(line, match[1]) || key });
    }
  }
  return steps;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';

/**
 * The lines a step shows: from its line to the end of the block that starts there, found without
 * parsing anything (decision 0056).
 *
 * The block ends at the first blank line whose next non-blank line is indented no deeper than the
 * starting line — a blank line *inside* a function is followed by the function's own, deeper,
 * body; the one after its closing brace is followed by the next declaration at the same depth. It
 * also ends before any line indented *less* than the start (the enclosing block closing with no
 * blank line in between), at the end of the file, and after `max` lines whatever happens.
 *
 * Null when the line is not in the file — the map is older than the code it points at.
 */
export function tourSnippet(text: string, line: number, max = SNIPPET_MAX_LINES): TourSnippet | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A file ending in a newline has an empty last "line" that is not a line of the file.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;

  const start = line - 1;
  const depth = indentOf(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length && i - start < max; i++) {
    if (isBlank(lines[i])) {
      let next = i + 1;
      while (next < lines.length && isBlank(lines[next])) next++;
      if (next >= lines.length || indentOf(lines[next]) <= depth) break;
      continue;
    }
    if (indentOf(lines[i]) < depth) break;
    end = i;
  }
  return { from: line, to: end + 1, text: lines.slice(start, end + 1).join('\n') };
}
