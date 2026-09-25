import guide from '../../../../docs/guide.md?raw';
import { el } from '../dom.js';
import { mountDocShell, splitSections } from '../panels/docshell.js';
import type { Store } from '../store.js';

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

export function mountHelp(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'help');
  host.appendChild(page);

  const shell = mountDocShell(page, {
    pages: splitSections(guide).map((section) => ({ ...section, section: 'Sections' })),
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
