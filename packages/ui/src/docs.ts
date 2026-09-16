/**
 * The docs tab's wire shapes and its page list. Pure — the DOM lives in `views/docs.ts`.
 *
 * `GET .../docs` answers with the index page and the decision log inline (both are short and
 * always wanted) plus a list of the other pages, which are fetched one at a time as they are
 * opened.
 */

export interface DocsPageRef {
  /** Path segment for `GET .../docs/:page`. */
  page: string;
  title: string;
}

export interface DocsIndex {
  /** The bundle's front page, already rendered-ready markdown. */
  index?: string;
  pages?: DocsPageRef[];
  /** The decision log, pinned to the bottom of the list. */
  decisions?: string;
}

export interface DocsPage {
  page: string;
  title: string;
  markdown: string;
}

export interface DocsEntry {
  /** Unique within the list; also the `page` to fetch for `kind: 'page'`. */
  key: string;
  title: string;
  kind: 'index' | 'page' | 'decisions';
  /** Already in hand for the index and the decision log; fetched for a page. */
  markdown?: string;
}

/** Index first, then the bundle's pages, then the pinned decision log. */
export function docsEntries(doc: DocsIndex | null): DocsEntry[] {
  if (!doc) return [];
  const entries: DocsEntry[] = [];
  if (typeof doc.index === 'string') {
    entries.push({ key: '__index', title: 'Overview', kind: 'index', markdown: doc.index });
  }
  for (const page of doc.pages ?? []) {
    if (!page?.page) continue;
    entries.push({ key: page.page, title: page.title?.trim() || page.page, kind: 'page' });
  }
  entries.push({
    key: '__decisions',
    title: 'Decision log',
    kind: 'decisions',
    markdown: doc.decisions ?? '',
  });
  return entries;
}
