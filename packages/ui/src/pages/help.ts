import { el } from '../dom.js';
import { mountDocShell, splitSections, type DocPage } from '../panels/docshell.js';
import type { Store } from '../store.js';
import { toolbar } from '../toolbar.js';

/**
 * The Help page: the user guide in the docs shell, so it reads like the documentation site it is.
 *
 * The guide is one page per topic in `docs/guide/`, read here as one continuous document: the shell
 * runs in `scroll` mode, each topic is a rail group and its `##` chapters the entries, and clicking
 * one jumps to it. The pages ship in the bundle (a raw glob import), so there is nothing to fetch
 * and nothing that can fail to load.
 */

const GUIDE_FILES = import.meta.glob<string>('../../../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * The guide's pages in the order `index.md` links them: the index's introduction first (its
 * `## Contents` list is the rail here, so it is not repeated), then each topic's chapters grouped
 * under the topic's `#` title. A page the index forgot still shows, last, rather than vanishing.
 * `files` maps a path (only its basename counts) to the page's markdown.
 */
export function guidePages(files: Record<string, string>): DocPage[] {
  const byName = new Map(Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]));
  const index = byName.get('index.md') ?? '';
  const listed = [...index.matchAll(/\]\(([\w-]+\.md)\)/g)].map((match) => match[1]);
  const order = [...new Set([...listed, ...[...byName.keys()].sort()])]
    .filter((name) => name !== 'index.md' && byName.has(name));

  const intro = splitSections(index)
    .filter((page) => page.title !== 'Contents')
    .map((page) => ({ ...page, section: 'Guide' }));
  return [
    ...intro,
    ...order.flatMap((name) => {
      const text = byName.get(name) ?? '';
      const topic = /^#[ \t]+(.*)$/.exec(text.trimStart().split('\n', 1)[0])?.[1].trim() || name;
      return splitSections(text, topic).map((page) => ({ ...page, section: topic }));
    }),
  ];
}

/** The guide's own contents list, still built the way the rest of the app expects it. */
export { docToc as guideToc } from '../panels/docshell.js';

export function mountHelp(host: HTMLElement, _store: Store): () => void {
  const view = el('div', 'view');
  const bar = toolbar();
  bar.leading.appendChild(el('h1', 'toolbar__title', 'Help'));
  const body = el('div', 'view__body');
  const page = el('div', 'help');
  body.appendChild(page);
  view.append(bar.root, body);
  host.appendChild(view);

  const shell = mountDocShell(page, {
    pages: guidePages(GUIDE_FILES),
    current: '',
    title: 'Guide',
    mode: 'scroll',
    // Scrolling owns the current section in this mode; the page has nothing to keep.
    onNavigate: () => {},
  });

  return () => {
    shell.destroy();
    host.replaceChildren();
  };
}
