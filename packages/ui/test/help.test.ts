import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { headingId } from '../src/markdown.js';
import { guidePages, guideToc } from '../src/pages/help.js';

const GUIDE = `# AgentHub guide

Some intro text.

## Getting started

Body.

### Installing

More body.

\`\`\`
## Not a heading
### Also not
\`\`\`

## Projects

### Creating a project

#### Too deep

Text.
`;

describe('guideToc', () => {
  it('returns the ## and ### headings in document order, with their level and text', () => {
    const toc = guideToc(GUIDE);
    expect(toc.map((h) => [h.level, h.text])).toEqual([
      [2, 'Getting started'],
      [3, 'Installing'],
      [2, 'Projects'],
      [3, 'Creating a project'],
    ]);
  });

  it('ignores the # (h1) title and anything deeper than ###', () => {
    const toc = guideToc(GUIDE);
    expect(toc.some((h) => h.text === 'AgentHub guide')).toBe(false);
    expect(toc.some((h) => h.text === 'Too deep')).toBe(false);
  });

  it('ignores headings inside a fenced code block', () => {
    const toc = guideToc(GUIDE);
    expect(toc.some((h) => h.text === 'Not a heading')).toBe(false);
    expect(toc.some((h) => h.text === 'Also not')).toBe(false);
  });

  it('gives each entry the id headingId would give its text', () => {
    for (const heading of guideToc(GUIDE)) expect(heading.id).toBe(headingId(heading.text));
  });

  it('has nothing to say about a document with no ## or ### headings', () => {
    expect(guideToc('# Title\n\nJust text.')).toEqual([]);
    expect(guideToc('')).toEqual([]);
  });
});

describe('guidePages', () => {
  const FILES = {
    '../docs/guide/index.md': '# The guide\n\nIntro.\n\n## Contents\n\n- [B](b.md)\n- [A](a.md)\n',
    '../docs/guide/a.md': '# Topic A\n\n## One\n\nText.\n\n```\n# not a title\n```\n',
    '../docs/guide/b.md': '# Topic B\n\n## Two\n\n### Deeper\n\n## Three\n',
    '../docs/guide/c.md': '# Topic C\n\n## Four\n',
  };

  it('puts the intro first, then the topics in the order the index links them', () => {
    expect(guidePages(FILES).map((page) => [page.section, page.title])).toEqual([
      ['Guide', 'The guide'],
      ['Topic B', 'Two'],
      ['Topic B', 'Three'],
      ['Topic A', 'One'],
      ['Topic C', 'Four'],
    ]);
  });

  it("leaves out the index's own contents list, which the rail replaces", () => {
    expect(guidePages(FILES).some((page) => page.title === 'Contents')).toBe(false);
  });

  it('keeps each chapter whole, sub-headings and code included', () => {
    const [, two] = guidePages(FILES);
    expect(two.markdown).toContain('### Deeper');
    expect(guidePages(FILES)[3].markdown).toContain('# not a title');
  });
});

describe('the real guide', () => {
  const dir = new URL('../../../docs/guide/', import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith('.md'));
  const files = Object.fromEntries(names.map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));

  it('has an index that links every page', () => {
    const index = files['index.md'];
    for (const name of names) if (name !== 'index.md') expect(index).toContain(`](${name})`);
  });

  it('shows every chapter of every page once, under a unique id', () => {
    const pages = guidePages(files);
    const chapters = names.filter((name) => name !== 'index.md')
      .flatMap((name) => guideToc(files[name]).filter((h) => h.level === 2).map((h) => h.text));
    expect(pages.slice(1).map((page) => page.title).sort()).toEqual(chapters.sort());
    expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
  });
});
