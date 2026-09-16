import { describe, it, expect } from 'vitest';
import { docsEntries } from '../src/docs.js';

describe('docsEntries', () => {
  it('puts the index first, the pages next, and pins the decision log last', () => {
    const entries = docsEntries({
      index: '# Overview',
      pages: [{ slug: 'architecture', title: 'Architecture' }, { slug: 'api', title: 'API' }],
      decisions: '# Decisions',
    });
    expect(entries.map((e) => e.kind)).toEqual(['index', 'page', 'page', 'decisions']);
    expect(entries.map((e) => e.title)).toEqual(['Overview', 'Architecture', 'API', 'Decision log']);
  });

  it('carries the markdown it already has, and leaves a page to be fetched', () => {
    const [index, page, decisions] = docsEntries({
      index: '# Overview', pages: [{ slug: 'a', title: 'A' }], decisions: '',
    });
    expect(index.markdown).toBe('# Overview');
    expect(page.markdown).toBeUndefined();
    expect(decisions.markdown).toBe('');
  });

  it('still offers the decision log when the bundle has nothing else in it', () => {
    expect(docsEntries({}).map((e) => e.kind)).toEqual(['decisions']);
  });

  it('names a page the hub gave no title for, and drops one with no path', () => {
    const entries = docsEntries({
      pages: [{ slug: 'notes', title: '  ' }, { slug: '', title: 'Nowhere' }],
    });
    expect(entries.filter((e) => e.kind === 'page').map((e) => e.title)).toEqual(['notes']);
  });

  it('has no list at all before the first answer arrives', () => {
    expect(docsEntries(null)).toEqual([]);
  });
});
