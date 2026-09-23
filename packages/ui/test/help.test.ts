import { describe, it, expect } from 'vitest';
import { headingId } from '../src/markdown.js';
import { guideToc } from '../src/pages/help.js';

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
