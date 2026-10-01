import { describe, it, expect } from 'vitest';
import { SNIPPET_MAX_LINES, tourSnippet, tourSteps } from '../src/tour.js';

describe('tour steps from a code map', () => {
  it('turns every path:line span into a step, in reading order, titled by the item text', () => {
    const map = [
      '# Code map',
      '',
      '## Entry points',
      '',
      '- `src/main.ts:1` — the process starts here.',
      '- **Routes:** `src/server.ts:40`',
      '',
      '## Underneath',
      '',
      '1. `src/db.ts:12` opens the `sqlite` file',
    ].join('\n');
    expect(tourSteps(map)).toEqual([
      { path: 'src/main.ts', line: 1, title: 'the process starts here.' },
      { path: 'src/server.ts', line: 40, title: 'Routes' },
      { path: 'src/db.ts', line: 12, title: 'opens the sqlite file' },
    ]);
  });

  it('skips code spans that are not references, repeats, and anything inside a fence', () => {
    const map = [
      '- `npm test` and `Note:12` are not links; `src/a.ts:3` is',
      '- `src/a.ts:3` again',
      '```',
      '`src/fenced.ts:1`',
      '```',
      '- `lib/b.py:7`',
    ].join('\n');
    expect(tourSteps(map).map((s) => `${s.path}:${s.line}`)).toEqual(['src/a.ts:3', 'lib/b.py:7']);
  });

  it('falls back to the reference itself when the item has no words', () => {
    expect(tourSteps('- `src/a.ts:3`')).toEqual([{ path: 'src/a.ts', line: 3, title: 'src/a.ts:3' }]);
  });

  it('is empty for a map with no references', () => {
    expect(tourSteps('# Code map\n\nNothing yet.\n')).toEqual([]);
  });
});

describe('the snippet a step shows', () => {
  const FILE = [
    "import { x } from './x.js';", // 1
    '', // 2
    'export function go(): number {', // 3
    '  const a = 1;', // 4
    '', // 5
    '  return a + x;', // 6
    '}', // 7
    '', // 8
    'export const later = 2;', // 9
    '', // the trailing newline
  ].join('\n');

  it('runs from the line to the end of the block, past blank lines inside it', () => {
    expect(tourSnippet(FILE, 3)).toEqual({
      from: 3, to: 7,
      text: 'export function go(): number {\n  const a = 1;\n\n  return a + x;\n}',
    });
  });

  it('stops where the enclosing block closes when there is no blank line first', () => {
    expect(tourSnippet(FILE, 6)).toEqual({ from: 6, to: 6, text: '  return a + x;' });
  });

  it('runs to the end of the file when nothing closes it', () => {
    expect(tourSnippet(FILE, 9)).toEqual({ from: 9, to: 9, text: 'export const later = 2;' });
  });

  it('caps a long block', () => {
    const long = ['function big() {', ...Array.from({ length: 100 }, (_, i) => `  line${i};`), '}'].join('\n');
    const snippet = tourSnippet(long, 1)!;
    expect(snippet.to - snippet.from + 1).toBe(SNIPPET_MAX_LINES);
  });

  it('is null for a line the file does not have', () => {
    expect(tourSnippet(FILE, 0)).toBeNull();
    expect(tourSnippet(FILE, 10)).toBeNull();
    expect(tourSnippet(FILE, 99)).toBeNull();
  });
});
