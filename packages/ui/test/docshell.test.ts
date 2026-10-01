import { describe, it, expect } from 'vitest';
import { headingId } from '../src/markdown.js';
import { docToc, groupPages, parseFrontMatter, splitSections, UNGROUPED } from '../src/panels/docshell.js';

describe('parseFrontMatter', () => {
  it('reads the bare key: value lines a page opens with', () => {
    const { fields, body } = parseFrontMatter('section: Architecture\n\n# How it works\n\nText.');
    expect(fields.section).toBe('Architecture');
    expect(body).toBe('# How it works\n\nText.');
  });

  it('reads the same block between --- fences', () => {
    const { fields, body } = parseFrontMatter('---\nsection: API\ntitle: Endpoints\n---\n\n# Endpoints');
    expect(fields).toEqual({ section: 'API', title: 'Endpoints' });
    expect(body).toBe('# Endpoints');
  });

  it('lowercases keys and trims values', () => {
    expect(parseFrontMatter('Section:   Ops  \n\nx').fields).toEqual({ section: 'Ops' });
  });

  it('stops at the first line that is not key: value', () => {
    const { fields, body } = parseFrontMatter('section: Ops\n# Title\nsection: ignored\n');
    expect(fields).toEqual({ section: 'Ops' });
    expect(body).toBe('# Title\nsection: ignored\n');
  });

  it('leaves a page that has no front matter completely alone', () => {
    const plain = '# Overview\n\nA link to [the docs](https://example.com).';
    expect(parseFrontMatter(plain)).toEqual({ fields: {}, body: plain });
    expect(parseFrontMatter('').body).toBe('');
  });

  it('leaves a page alone when its bare opening lines hold a key other than section or title', () => {
    const status = 'Status: draft\n\nThe plan is still moving.';
    expect(parseFrontMatter(status)).toEqual({ fields: {}, body: status });
    const mixed = 'section: Ops\nOwner: Gio\n\n# Title';
    expect(parseFrontMatter(mixed)).toEqual({ fields: {}, body: mixed });
  });

  it('reads a bare title alongside section', () => {
    expect(parseFrontMatter('title: Endpoints\nsection: API\n\nx')).toEqual({
      fields: { title: 'Endpoints', section: 'API' },
      body: 'x',
    });
  });

  it('accepts any key between --- fences', () => {
    const { fields, body } = parseFrontMatter('---\nStatus: draft\nsection: Ops\n---\nBody');
    expect(fields).toEqual({ status: 'draft', section: 'Ops' });
    expect(body).toBe('Body');
  });

  it('gives the whole document back when a --- block is never closed', () => {
    const unterminated = '---\nsection: Ops\n\n# Title\n';
    expect(parseFrontMatter(unterminated)).toEqual({ fields: {}, body: unterminated });
  });
});

describe('groupPages', () => {
  const page = (id: string, section?: string) => ({ id, title: id.toUpperCase(), section, markdown: '' });

  it('groups by section, in the order each section first appears', () => {
    const sections = groupPages([page('a', 'Guides'), page('b', 'API'), page('c', 'Guides')]);
    expect(sections.map((s) => s.name)).toEqual(['Guides', 'API']);
    expect(sections[0].pages.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('keeps the pages of a section in the order they were given', () => {
    const [only] = groupPages([page('b', 'API'), page('a', 'API')]);
    expect(only.pages.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('lands a page with no section, or a blank one, under "Pages"', () => {
    const sections = groupPages([page('a'), page('b', '   ')]);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe(UNGROUPED);
    expect(sections[0].pages.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('has no groups at all when there are no pages', () => {
    expect(groupPages([])).toEqual([]);
  });
});

const GUIDE = `# The guide

Intro text.

## Getting started

Body.

### Installing

More.

\`\`\`
## Not a heading
\`\`\`

## Projects

Text.
`;

describe('splitSections', () => {
  it('splits a document at its ## headings, keeping each heading with its section', () => {
    const pages = splitSections(GUIDE);
    expect(pages.map((p) => p.title)).toEqual(['The guide', 'Getting started', 'Projects']);
    expect(pages[1].markdown.startsWith('## Getting started')).toBe(true);
    expect(pages[1].markdown).toContain('### Installing');
  });

  it('makes the text above the first ## a page titled by the document’s # heading', () => {
    const [first] = splitSections(GUIDE);
    expect(first.title).toBe('The guide');
    expect(first.markdown).toBe('Intro text.');
    expect(first.id).toBe(headingId('The guide'));
  });

  it('does not split on a ## inside a fenced code block', () => {
    expect(splitSections(GUIDE).some((p) => p.title === 'Not a heading')).toBe(false);
    expect(splitSections(GUIDE)[1].markdown).toContain('## Not a heading');
  });

  it('names the preamble page with the fallback when the document has no # heading', () => {
    const [first] = splitSections('Loose text.\n\n## One\n', 'Overview');
    expect(first.title).toBe('Overview');
  });

  it('makes no preamble page when the document starts with a section', () => {
    expect(splitSections('## One\n\nx\n').map((p) => p.title)).toEqual(['One']);
  });

  it('gives each page the id its heading would get', () => {
    for (const page of splitSections(GUIDE)) expect(page.id).toBe(headingId(page.title));
  });
});

describe('docToc', () => {
  it('returns the ## and ### headings in document order, with their level and text', () => {
    expect(docToc(GUIDE).map((h) => [h.level, h.text])).toEqual([
      [2, 'Getting started'],
      [3, 'Installing'],
      [2, 'Projects'],
    ]);
  });

  it('ignores the # title, anything deeper than ###, and headings inside a fence', () => {
    const toc = docToc(`${GUIDE}\n#### Too deep\n`);
    expect(toc.some((h) => h.text === 'The guide')).toBe(false);
    expect(toc.some((h) => h.text === 'Too deep')).toBe(false);
    expect(toc.some((h) => h.text === 'Not a heading')).toBe(false);
  });

  it('gives each entry the id headingId would give its text', () => {
    for (const entry of docToc(GUIDE)) expect(entry.id).toBe(headingId(entry.text));
  });

  it('has nothing to say about a document with no ## or ### headings', () => {
    expect(docToc('# Title\n\nJust text.')).toEqual([]);
    expect(docToc('')).toEqual([]);
  });
});
