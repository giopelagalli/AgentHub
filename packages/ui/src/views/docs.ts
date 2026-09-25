import { getJson } from '../api.js';
import { docsEntries, type DocsIndex, type DocsPage } from '../docs.js';
import { button, el } from '../dom.js';
import {
  mountDocShell, parseFrontMatter, type DocPage, type DocShellHandle,
} from '../panels/docshell.js';
import { chatToAdjust, docBar, note, type ViewContext } from './parts.js';

/**
 * The docs view: the project's pages in the docs shell — grouped, filterable, with a breadcrumb
 * and the page's own headings beside it. The "chat to adjust" drawer is the sheet's, not this
 * view's, so it still docks to the right of the whole thing.
 *
 * A page's group comes from its own front matter (`section: Architecture` on the first lines),
 * which means the rail cannot be drawn until the pages have been read — so all of them are
 * fetched as soon as the index lands, rather than one at a time as they are opened. Docs bundles
 * are a handful of short files on the same machine; the alternative is a sidebar that reshuffles
 * itself under the reader as they browse.
 */

/** The two pages that are reference material rather than a chapter of the docs. */
const CODE_MAP = /^code[-_]?map$/i;

export function mountDocs(host: HTMLElement, ctx: ViewContext): () => void {
  let index: DocsIndex | null = null;
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let failure = '';
  let selected = '';
  /** Page markdown, keyed as `docsEntries` keys them; absent until its fetch lands. */
  const fetched = new Map<string, string>();
  let listToken = 0;
  let alive = true;
  let shell: DocShellHandle | null = null;

  /**
   * The rail's pages: the bundle's own, then the reference pair (the code map and the decision
   * log) which are pinned into a group of their own however they are written.
   */
  const pages = (): DocPage[] => {
    const chapters: DocPage[] = [];
    const reference: DocPage[] = [];
    for (const entry of docsEntries(index)) {
      const raw = entry.markdown ?? fetched.get(entry.key);
      const front = raw === undefined ? null : parseFrontMatter(raw);
      const section = front?.fields.section?.trim() || undefined;
      // The decision log and the code map are reference material whatever they say they are, and
      // the group goes last — a reader looks things up in it, they do not read it first.
      const isReference = entry.kind === 'decisions' || CODE_MAP.test(entry.key) || section === 'Reference';
      const page: DocPage = {
        id: entry.key,
        title: front?.fields.title?.trim() || entry.title,
        section: isReference ? 'Reference' : section,
        markdown: front?.body ?? '',
      };
      (isReference ? reference : chapters).push(page);
    }
    return [...chapters, ...reference];
  };

  const refresh = (): void => {
    if (shell) shell.update({ pages: pages(), current: selected });
    else render();
  };

  /** One page's markdown. A failure is written into the page as a callout rather than a toast. */
  const fetchPage = (key: string): void => {
    void getJson<DocsPage>(`/api/projects/${ctx.slug}/docs/${encodeURIComponent(key)}`)
      .then((next) => { fetched.set(key, next.markdown ?? ''); })
      .catch(() => { fetched.set(key, ':::danger\nThis page could not be read.\n:::'); })
      .finally(() => { if (alive) refresh(); });
  };

  const load = (): void => {
    const mine = ++listToken;
    if (!index) state = 'loading';
    void getJson<DocsIndex>(`/api/projects/${ctx.slug}/docs`)
      .then((next) => {
        if (mine !== listToken || !alive) return;
        index = next;
        state = 'ready';
        fetched.clear();
        const entries = docsEntries(index);
        // Keep the reader where they were, unless that page is gone.
        if (!entries.some((entry) => entry.key === selected)) selected = entries[0]?.key ?? '';
        render();
        for (const entry of entries) if (entry.markdown === undefined) fetchPage(entry.key);
      })
      .catch((error: unknown) => {
        if (mine !== listToken || !alive) return;
        state = 'failed';
        failure = `Could not load the docs: ${String(error)}`;
        render();
      });
  };

  function render(): void {
    host.replaceChildren();
    const { bar, actions } = docBar();
    host.appendChild(bar);

    if (state === 'loading') { host.appendChild(note('Loading the docs…')); return; }

    if (state === 'failed') {
      host.appendChild(note(failure, 'error'));
      const retry = button('Try again');
      retry.addEventListener('click', load);
      actions.appendChild(retry);
      return;
    }

    actions.appendChild(chatToAdjust(ctx, 'docs', load));

    const list = pages();
    if (!list.length) {
      host.appendChild(note('No docs yet — the writer fills this in as the project runs.'));
      return;
    }

    if (shell) {
      host.appendChild(shell.root);
      shell.update({ pages: list, current: selected });
      return;
    }
    shell = mountDocShell(host, {
      pages: list,
      current: selected,
      title: 'Docs',
      onNavigate: (id) => { selected = id; refresh(); },
    });
  }

  render();
  load();

  return () => {
    alive = false;
    listToken++;
    shell?.destroy();
    shell = null;
    host.replaceChildren();
  };
}
