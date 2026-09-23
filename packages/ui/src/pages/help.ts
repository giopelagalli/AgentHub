import guide from '../../../../docs/guide.md?raw';
import { el } from '../dom.js';
import { headingId, renderMarkdown } from '../markdown.js';
import type { Store } from '../store.js';

/**
 * The Help page: the user guide, rendered GitBook-style — a table of contents built from its
 * `##`/`###` headings on the left, the guide itself on the right. The guide ships in the bundle
 * (a raw import), so there is nothing to fetch and nothing that can fail to load.
 */

const FENCE = /^\s*```/;
const TOC_HEADING = /^(##|###)[ \t]+(.*)$/;

/** The `##`/`###` headings in `markdown`, in document order, skipping any fenced code block. */
export function guideToc(markdown: string): { id: string; level: 2 | 3; text: string }[] {
  const entries: { id: string; level: 2 | 3; text: string }[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = TOC_HEADING.exec(line);
    if (!heading) continue;
    const text = heading[2].trim();
    entries.push({ id: headingId(text), level: heading[1].length as 2 | 3, text });
  }
  return entries;
}

/** Renders the guide into `host`: the table of contents on the left, the document on the right. */
export function mountHelp(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'help');

  const nav = el('nav', 'help__toc');
  nav.setAttribute('aria-label', 'Guide contents');

  const body = el('article', 'help__body md');
  body.innerHTML = renderMarkdown(guide);

  for (const heading of guideToc(guide)) {
    const link = el('a', heading.level === 3 ? 'help__toc--sub' : undefined, heading.text);
    link.href = `#${heading.id}`;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      body.querySelector(`[id="${CSS.escape(heading.id)}"]`)?.scrollIntoView({ block: 'start' });
    });
    nav.appendChild(link);
  }

  page.append(nav, body);
  host.appendChild(page);

  return () => {
    host.replaceChildren();
  };
}
