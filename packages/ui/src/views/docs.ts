import { getJson } from '../api.js';
import { docsEntries, type DocsEntry, type DocsIndex, type DocsPage } from '../docs.js';
import { button, el } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { chatToAdjust, docBar, note, type ViewContext } from './parts.js';

/**
 * The docs tab: the bundle's pages on the left, the one being read on the right. The index and the
 * decision log come down with the list; the other pages are fetched as they are opened.
 */
export function mountDocs(host: HTMLElement, ctx: ViewContext): () => void {
  let index: DocsIndex | null = null;
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let failure = '';
  let selected: string | null = null;
  /** The right-hand pane's own state, which moves independently of the list's. */
  let page: { state: 'loading' | 'ready' | 'failed'; markdown: string; message: string } =
    { state: 'loading', markdown: '', message: '' };
  let listToken = 0;
  let pageToken = 0;
  let alive = true;

  const load = (): void => {
    const mine = ++listToken;
    if (!index) state = 'loading';
    void getJson<DocsIndex>(`/api/projects/${ctx.slug}/docs`)
      .then((next) => {
        if (mine !== listToken || !alive) return;
        index = next;
        state = 'ready';
        const entries = docsEntries(index);
        // Keep the reader where they were, unless that page is gone.
        if (!entries.some((entry) => entry.key === selected)) selected = entries[0]?.key ?? null;
        render();
        openSelected();
      })
      .catch((error: unknown) => {
        if (mine !== listToken || !alive) return;
        state = 'failed';
        failure = `Could not load the docs: ${String(error)}`;
        render();
      });
  };

  /** Puts whichever entry is selected into the right-hand pane, fetching it if it isn't in hand. */
  const openSelected = (): void => {
    const entry = docsEntries(index).find((row) => row.key === selected);
    const mine = ++pageToken;
    if (!entry) {
      page = { state: 'ready', markdown: '', message: '' };
      render();
      return;
    }
    if (entry.markdown !== undefined) {
      page = { state: 'ready', markdown: entry.markdown, message: '' };
      render();
      return;
    }
    page = { state: 'loading', markdown: '', message: '' };
    render();
    void getJson<DocsPage>(`/api/projects/${ctx.slug}/docs/${encodeURIComponent(entry.key)}`)
      .then((next) => {
        if (mine !== pageToken || !alive) return;
        page = { state: 'ready', markdown: next.markdown ?? '', message: '' };
        render();
      })
      .catch((error: unknown) => {
        if (mine !== pageToken || !alive) return;
        page = { state: 'failed', markdown: '', message: `Could not load ${entry.title}: ${String(error)}` };
        render();
      });
  };

  const listNode = (entries: DocsEntry[]): HTMLElement => {
    const list = el('nav', 'docs__list');
    list.setAttribute('aria-label', 'Pages');
    for (const entry of entries) {
      const row = button(entry.title, entry.kind === 'decisions' ? 'docs__row docs__row--pinned' : 'docs__row');
      if (entry.key === selected) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        if (entry.key === selected) return;
        selected = entry.key;
        openSelected();
      });
      list.appendChild(row);
    }
    return list;
  };

  const pageNode = (entries: DocsEntry[]): HTMLElement => {
    const entry = entries.find((row) => row.key === selected);
    if (page.state === 'loading') return note(`Loading ${entry?.title ?? 'the page'}…`);
    if (page.state === 'failed') return note(page.message, 'error');
    if (!page.markdown.trim()) {
      return note(entry?.kind === 'decisions'
        ? 'No decisions recorded yet.'
        : 'This page is empty.');
    }
    const body = el('article', 'md docs__page');
    body.innerHTML = renderMarkdown(page.markdown);
    return body;
  };

  function render(): void {
    host.replaceChildren();
    const { bar, actions } = docBar('Docs');
    host.appendChild(bar);

    if (state === 'loading') { host.appendChild(note('Loading the docs…')); return; }

    if (state === 'failed') {
      host.appendChild(note(failure, 'error'));
      const retry = button('Try again');
      retry.addEventListener('click', load);
      actions.appendChild(retry);
      return;
    }

    const entries = docsEntries(index);
    actions.appendChild(chatToAdjust(ctx, 'docs', load));

    if (!entries.length) {
      host.appendChild(note('No docs yet — the writer fills this in as the project runs.'));
      return;
    }

    const panes = el('div', 'docs');
    panes.append(listNode(entries), pageNode(entries));
    host.appendChild(panes);
  }

  render();
  load();

  return () => {
    alive = false;
    listToken++;
    pageToken++;
    host.replaceChildren();
  };
}
