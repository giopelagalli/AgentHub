import { describe, it, expect } from 'vitest';
import { codeSummary } from '../src/artifacts.js';
import { ancestors, formatSize, step, visibleRows, type CodeEntry } from '../src/code/model.js';
import { codeRef, renderMarkdown } from '../src/markdown.js';

const dir = (path: string): CodeEntry => ({ path, dir: true, size: 0, openable: false });
const file = (path: string, openable = true): CodeEntry => ({ path, dir: false, size: 120, openable });

/** The shape the hub sends: flat, alphabetical, a directory ahead of what is in it. */
const ENTRIES: CodeEntry[] = [
  file('package.json'),
  dir('src'),
  file('src/main.ts'),
  dir('src/lib'),
  file('src/lib/util.ts'),
  file('logo.png', false),
];

describe('the file tree model', () => {
  it('hides what is inside a folder until the folder is open', () => {
    expect(visibleRows(ENTRIES, new Set()).map((r) => r.entry.path)).toEqual(['package.json', 'src', 'logo.png']);
    expect(visibleRows(ENTRIES, new Set(['src'])).map((r) => r.entry.path))
      .toEqual(['package.json', 'src', 'src/main.ts', 'src/lib', 'logo.png']);
    expect(visibleRows(ENTRIES, new Set(['src', 'src/lib'])).map((r) => r.entry.path))
      .toEqual(['package.json', 'src', 'src/main.ts', 'src/lib', 'src/lib/util.ts', 'logo.png']);
  });

  it('indents a row by how deep its path is, and labels it with the last segment', () => {
    const rows = visibleRows(ENTRIES, new Set(['src', 'src/lib']));
    expect(rows.find((r) => r.entry.path === 'src/lib/util.ts')).toMatchObject({ depth: 2, name: 'util.ts' });
    expect(rows.find((r) => r.entry.path === 'package.json')).toMatchObject({ depth: 0, name: 'package.json' });
  });

  it('names the folders that have to be open for a path to show', () => {
    expect(ancestors('src/lib/util.ts')).toEqual(['src', 'src/lib']);
    expect(ancestors('package.json')).toEqual([]);
  });

  it('walks the visible rows and stops at either end', () => {
    const rows = visibleRows(ENTRIES, new Set());
    expect(step(rows, null, 1)).toBe('package.json');
    expect(step(rows, 'package.json', 1)).toBe('src');
    expect(step(rows, 'package.json', -1)).toBe('package.json');
    expect(step(rows, 'logo.png', 1)).toBe('logo.png');
    expect(step([], 'anything', 1)).toBe(null);
  });

  it('formats a size', () => {
    expect(formatSize(240)).toBe('240 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('a path:line citation', () => {
  it('is recognised only when it names a file and a line', () => {
    expect(codeRef('src/main.ts:12')).toEqual({ path: 'src/main.ts', line: 12 });
    expect(codeRef('package.json:1')).toEqual({ path: 'package.json', line: 1 });
    for (const text of ['Note:12', 'src/main.ts', 'src/main.ts:', ':12', 'http://x.dev:8080', 'a b.ts:2']) {
      expect(codeRef(text), text).toBe(null);
    }
  });

  it('becomes a link carrying the path and the line, and other code spans do not', () => {
    const html = renderMarkdown('- `src/main.ts:12` — the entry point, unlike `npm test`.');
    expect(html).toContain('<a class="md__ref" data-path="src/main.ts" data-line="12"><code>src/main.ts:12</code></a>');
    expect(html).toContain('<code>npm test</code>');
    expect(html).not.toContain('<a class="md__ref" data-path="npm test"');
  });

  it('still escapes first: a span cannot smuggle markup into the link', () => {
    const html = renderMarkdown('`<img src=x onerror=1>:12`');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the code button', () => {
  it('counts the files and says how fresh the map is', () => {
    const now = 1_700_000_000_000;
    expect(codeSummary('ready', { files: 12, truncated: false, map: { updatedAt: now - 300_000 } }, now).hint)
      .toBe('12 files · map updated 5m00s ago');
    expect(codeSummary('ready', { files: 1, truncated: false, map: null }, now).hint).toBe('1 file · no map yet');
    expect(codeSummary('ready', { files: 5000, truncated: true, map: null }, now).hint).toBe('5000 files+ · no map yet');
  });

  it('reads quiet with nothing in the workspace, and while it is loading', () => {
    const now = Date.now();
    expect(codeSummary('ready', { files: 0, truncated: false, map: null }, now))
      .toMatchObject({ hint: 'Nothing in the workspace yet', filled: false });
    expect(codeSummary('loading', null, now).hint).toBe('Loading…');
    expect(codeSummary('failed', null, now).hint).toBe('Could not be read');
  });
});
