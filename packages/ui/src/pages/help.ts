import guide from '../../../../docs/guide.md?raw';
import { el } from '../dom.js';
import { mountDocShell, splitSections } from '../panels/docshell.js';
import type { Store } from '../store.js';
import { toolbar } from '../toolbar.js';

/**
 * The Help page: the user guide in the docs shell, so it reads like the documentation site it is.
 *
 * The guide is one document, not a bundle of pages, so the shell runs in `scroll` mode: its `##`
 * chapters become the left rail's entries and clicking one jumps to it, but the whole guide stays
 * on screen as one continuous read. The guide ships in the bundle (a raw import), so there is
 * nothing to fetch and nothing that can fail to load.
 */

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
    pages: splitSections(guide).map((section) => ({ ...section, section: 'Guide' })),
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
