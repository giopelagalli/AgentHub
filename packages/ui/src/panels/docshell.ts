import { el } from '../dom.js';
import { headingId, renderDocMarkdown } from '../markdown.js';

/**
 * The docs shell: one documentation layout, used by the Docs sheet, the PRD sheet and Help.
 *
 * Three columns, the shape every documentation site has settled on. On the left, the pages,
 * grouped into collapsible sections with a filter box over them and the one being read lit up. In
 * the middle, a breadcrumb, a large title, the document at a reading measure, and the pages either
 * side of it. On the right, *On this page* — the document's own `##`/`###` headings, with the one
 * you are looking at tracked as you scroll.
 *
 * Two modes, because two kinds of documentation live in this app:
 *
 * - `page` — the pages are separate documents; the rail swaps between them.
 * - `scroll` — the pages are the `##` sections of one document; the rail scrolls to them. Help and
 *   anything else that is one long read use this, so the left rail still mirrors a docs site
 *   without pretending one file is many.
 *
 * The shell does not scroll: it grows inside whatever scroller it was mounted in (the sheet's body,
 * the page), and its two rails are sticky against that scroller. The breakpoints are *container*
 * queries, not viewport ones — the sheet loses a third of its width the moment the "chat to adjust"
 * drawer docks beside it, and the layout has to answer to that, not to the window.
 */

export interface DocPage {
  /** Unique within the shell; also the element id scrolled to in `scroll` mode. */
  id: string;
  title: string;
  /** The rail group this page belongs to; pages without one land under "Pages". */
  section?: string;
  markdown: string;
}

export interface DocSection {
  name: string;
  pages: DocPage[];
}

export interface DocShellOptions {
  pages: DocPage[];
  /** The page id being read. Ignored in `scroll` mode after the first paint — scrolling owns it. */
  current: string;
  /** Called when the reader picks another page (and, in `scroll` mode, when they scroll into one). */
  onNavigate(id: string): void;
  /** The root of the breadcrumb, and the title in `scroll` mode: "Docs", "PRD", "Guide". */
  title: string;
  /** One chip beside the title — the PRD's completeness score. */
  badge?: string;
  mode?: 'page' | 'scroll';
}

export interface DocShellHandle {
  /** The shell's own element, so a view can re-append it without rebuilding it. */
  root: HTMLElement;
  update(next: Partial<DocShellOptions>): void;
  /** Open a page the way a rail click does — scrolled to its top, or to it in `scroll` mode. */
  navigate(id: string): void;
  destroy(): void;
}

/** Where a page with no `section` of its own goes. */
export const UNGROUPED = 'Pages';

const FENCE = /^\s*```/;
const TOC_HEADING = /^(##|###)[ \t]+(.*)$/;
const SECTION_HEADING = /^##[ \t]+(.*)$/;
const LEAD_HEADING = /^(#{1,2})[ \t]+(.*)$/;
const FRONT_MATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const FRONT_MATTER_FENCE = /^---[ \t]*$/;
/** The only keys unfenced front matter may hold; anything else means the lines are prose. */
const BARE_KEYS = new Set(['section', 'title']);

export interface TocEntry { id: string; level: 2 | 3; text: string }

/** The `##`/`###` headings in `markdown`, in document order, skipping any fenced code block. */
export function docToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
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

export interface FrontMatter {
  /** The `key: value` lines at the top of the page, keys lowercased. */
  fields: Record<string, string>;
  /** Everything after them — what actually gets rendered. */
  body: string;
}

/**
 * The `key: value` lines an agent puts at the top of a page, with or without `---` fences around
 * them. Deliberately tiny: no nesting, no lists, no quoting rules — the only field the app reads is
 * `section`, and the parse exists so a page that opens with one does not render it as a paragraph.
 *
 * Bare (unfenced) front matter stops at the first line that is not `key: value`, which is why a
 * page that simply starts with prose keeps every word of it. It is also held to the keys the app
 * knows (`section`, `title`): a page that opens with "Status: draft" is prose, not metadata, so a
 * bare block holding any other key is left in the document untouched. Inside `---` fences, any key
 * goes — the fences say it is front matter.
 */
export function parseFrontMatter(markdown: string): FrontMatter {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  const fenced = at < lines.length && FRONT_MATTER_FENCE.test(lines[at]);
  if (fenced) at++;

  const fields: Record<string, string> = {};
  let read = at;
  while (read < lines.length) {
    const line = lines[read];
    if (fenced && FRONT_MATTER_FENCE.test(line)) { read++; break; }
    if (fenced && !line.trim()) { read++; continue; }
    const field = FRONT_MATTER_LINE.exec(line);
    // A heading (`# Title`) and a link (`[a](b)`) both fail this, which is the point.
    if (!field) {
      // An unterminated `---` block was never front matter; give the whole document back.
      if (fenced) return { fields: {}, body: markdown };
      break;
    }
    const key = field[1].toLowerCase();
    if (!fenced && !BARE_KEYS.has(key)) return { fields: {}, body: markdown };
    fields[key] = field[2].trim();
    read++;
  }

  if (!Object.keys(fields).length) return { fields: {}, body: markdown };
  return { fields, body: lines.slice(read).join('\n').replace(/^\n+/, '') };
}

/**
 * The rail's groups: sections in the order their first page appears, pages in the order given.
 * Callers that want a group last (the docs view's "Reference") simply pass its pages last.
 */
export function groupPages(pages: DocPage[]): DocSection[] {
  const sections: DocSection[] = [];
  for (const page of pages) {
    const name = page.section?.trim() || UNGROUPED;
    const existing = sections.find((section) => section.name === name);
    if (existing) existing.pages.push(page);
    else sections.push({ name, pages: [page] });
  }
  return sections;
}

/**
 * One document split at its `##` headings — the PRD's twelve sections, the guide's chapters. Text
 * above the first `##` becomes a page of its own, titled by the document's `#` heading, so an
 * introduction is not stranded.
 */
export function splitSections(markdown: string, preambleTitle = 'Overview'): DocPage[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const pages: DocPage[] = [];
  const preamble: string[] = [];
  let title = preambleTitle;
  let current: DocPage | null = null;
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : SECTION_HEADING.exec(line);
    if (heading) {
      const text = heading[1].trim();
      current = { id: headingId(text), title: text, markdown: line };
      pages.push(current);
      continue;
    }
    if (current) { current.markdown += `\n${line}`; continue; }
    const lead = inFence ? null : /^#[ \t]+(.*)$/.exec(line);
    if (lead && !preamble.join('').trim()) { title = lead[1].trim(); continue; }
    preamble.push(line);
  }

  if (preamble.join('\n').trim()) {
    pages.unshift({ id: headingId(title), title, markdown: preamble.join('\n').trim() });
  }
  return pages;
}

/**
 * The document's own opening heading, lifted out of the body so the shell can set it in the title
 * row instead. A `#` always belongs to the title row; a `##` only when it is the page's own name,
 * which is how a slice of a split document comes in.
 */
function liftTitle(page: DocPage): { title: string; body: string } {
  const lines = page.markdown.replace(/\r\n?/g, '\n').split('\n');
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  const lead = at < lines.length ? LEAD_HEADING.exec(lines[at]) : null;
  if (!lead) return { title: page.title, body: page.markdown };
  const text = lead[2].trim();
  if (lead[1].length === 2 && text !== page.title) return { title: page.title, body: page.markdown };
  return { title: text || page.title, body: lines.slice(at + 1).join('\n').replace(/^\n+/, '') };
}

function icon(paths: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const HOME_ICON = '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 10v9h12v-9"/>';
const CHEVRON_ICON = '<path d="M9 5l7 7-7 7"/>';

/** The scroller the shell was mounted inside — what the rails stick to and the observer watches. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return null;
}

/** Below this the *On this page* list becomes a disclosure; below the second, so does the rail. */
const TOC_BREAK = 1100;
const RAIL_BREAK = 800;

/** How long the scroller must sit still after a rail jump before the section spy resumes. */
const SETTLE_MS = 150;

export function mountDocShell(host: HTMLElement, options: DocShellOptions): DocShellHandle {
  let opts: DocShellOptions = { mode: 'page', ...options };
  let current = opts.current;
  let filter = '';
  const collapsed = new Set<string>();

  // The grid lives one level inside the container element: a container query styles a container's
  // descendants, never the container itself, and it is the grid that has to answer to the width.
  const root = el('div', 'docshell-box');
  const grid = el('div', 'docshell');
  root.appendChild(grid);

  const rail = el('details', 'docshell__rail');
  rail.open = true;
  const railHead = el('summary', 'docshell__rail-head', 'Pages');
  const filterBox = el('input', 'docshell__filter');
  filterBox.type = 'search';
  filterBox.placeholder = 'Filter pages';
  filterBox.setAttribute('aria-label', 'Filter pages');
  const railList = el('nav', 'docshell__groups');
  railList.setAttribute('aria-label', 'Pages');
  rail.append(railHead, filterBox, railList);

  const main = el('main', 'docshell__main');
  const crumbs = el('nav', 'docshell__crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const titleRow = el('div', 'docshell__title');
  const heading = el('h1');
  const badge = el('span', 'docshell__badge');
  titleRow.append(heading, badge);
  const article = el('article', 'md doc-md');
  const pager = el('nav', 'docshell__pager');
  pager.setAttribute('aria-label', 'Nearby pages');
  main.append(crumbs, titleRow, article, pager);

  const toc = el('details', 'docshell__toc');
  toc.open = true;
  const tocHead = el('summary', 'docshell__toc-head', 'On this page');
  const tocList = el('nav', 'docshell__toc-list');
  tocList.setAttribute('aria-label', 'On this page');
  toc.append(tocHead, tocList);

  grid.append(rail, main, toc);
  host.appendChild(root);
  // The shell brings its own measure; a host that centres a reading column must stand down.
  host.classList.add('docshell-host');

  // The scroller is looked up each time it is needed, never cached: a view may re-append the
  // shell somewhere else, and the observers have to watch whatever it sits in now.
  let headingSpy: IntersectionObserver | null = null;
  let sectionSpy: IntersectionObserver | null = null;
  let activeHeading = '';
  /**
   * While set, a rail jump in `scroll` mode is still scrolling, and the section spy keeps quiet —
   * otherwise a short last section, which can never reach the spy's band, would light the one
   * above it the moment the jump lands.
   */
  let settle: ReturnType<typeof setTimeout> | null = null;
  let settleOn: EventTarget | null = null;
  const onSettleScroll = (): void => { armSettle(); };
  function armSettle(): void {
    if (settle) clearTimeout(settle);
    settle = setTimeout(releaseSpy, SETTLE_MS);
  }
  function releaseSpy(): void {
    if (settle) clearTimeout(settle);
    settle = null;
    settleOn?.removeEventListener('scroll', onSettleScroll);
    settleOn = null;
  }
  function holdSpy(): void {
    releaseSpy();
    settleOn = scrollParent(root) ?? window;
    settleOn.addEventListener('scroll', onSettleScroll, { passive: true });
    armSettle();
  }

  const flat = (): DocPage[] => groupPages(opts.pages).flatMap((section) => section.pages);

  const page = (): DocPage | null => {
    const pages = flat();
    return pages.find((item) => item.id === current) ?? pages[0] ?? null;
  };

  const sectionOf = (id: string): string | null =>
    groupPages(opts.pages).find((section) => section.pages.some((item) => item.id === id))?.name ?? null;

  const scrollTo = (id: string): void => {
    const target = article.querySelector(`[id="${CSS.escape(id)}"]`)
      ?? article.querySelector(`[data-page="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'start' });
  };

  const go = (id: string): void => {
    if (opts.mode === 'scroll') {
      current = id;
      paintRail();
      paintCrumbs();
      paintToc();
      holdSpy();
      scrollTo(id);
      opts.onNavigate(id);
      return;
    }
    if (id === current) return;
    opts.onNavigate(id);
    scrollParent(root)?.scrollTo({ top: 0 });
  };

  /** The rail: one group per section, the current page lit, everything the filter drops hidden. */
  function paintRail(): void {
    railList.replaceChildren();
    const needle = filter.trim().toLowerCase();
    let shown = 0;

    for (const section of groupPages(opts.pages)) {
      const pages = needle
        ? section.pages.filter((item) => item.title.toLowerCase().includes(needle))
        : section.pages;
      if (!pages.length) continue;
      shown += pages.length;

      const group = el('div', 'docshell__group');
      const open = needle ? true : !collapsed.has(section.name);
      const head = el('button', 'docshell__group-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));
      head.append(icon(CHEVRON_ICON, 12), el('span', undefined, section.name));
      head.addEventListener('click', () => {
        if (collapsed.has(section.name)) collapsed.delete(section.name);
        else collapsed.add(section.name);
        paintRail();
      });

      const list = el('div', 'docshell__group-list');
      list.hidden = !open;
      for (const item of pages) {
        const link = el('button', 'docshell__link', item.title);
        link.type = 'button';
        if (item.id === current) link.setAttribute('aria-current', 'page');
        link.addEventListener('click', () => go(item.id));
        list.appendChild(link);
      }

      group.append(head, list);
      railList.appendChild(group);
    }

    if (!shown) railList.appendChild(el('p', 'docshell__none', 'No page matches.'));
  }

  function paintCrumbs(): void {
    crumbs.replaceChildren();
    const home = el('button', 'docshell__crumb docshell__crumb--home');
    home.type = 'button';
    home.title = opts.title;
    home.append(icon(HOME_ICON, 13), el('span', undefined, opts.title));
    home.addEventListener('click', () => { const first = flat()[0]; if (first) go(first.id); });
    crumbs.appendChild(home);

    const here = page();
    const section = here ? sectionOf(here.id) : null;
    for (const step of [section, here?.title].filter((text): text is string => Boolean(text))) {
      crumbs.appendChild(el('span', 'docshell__sep', '›'));
      crumbs.appendChild(el('span', 'docshell__crumb', step));
    }
  }

  /** The contents list, and the observer that follows it. */
  function paintToc(): void {
    const here = page();
    let entries: TocEntry[] = [];
    if (here) {
      if (opts.mode === 'scroll') {
        entries = docToc(here.markdown);
        if (entries[0]?.level === 2 && entries[0].text === here.title) entries.shift();
      } else {
        entries = docToc(liftTitle(here).body);
      }
    }

    tocList.replaceChildren();
    toc.hidden = !entries.length;
    for (const entry of entries) {
      const link = el('a', entry.level === 3 ? 'docshell__toc-link docshell__toc-link--sub' : 'docshell__toc-link', entry.text);
      link.href = `#${entry.id}`;
      link.dataset.heading = entry.id;
      link.addEventListener('click', (event) => { event.preventDefault(); scrollTo(entry.id); });
      tocList.appendChild(link);
    }

    headingSpy?.disconnect();
    if (!entries.length) return;
    headingSpy = new IntersectionObserver((records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        activeHeading = record.target.id;
        break;
      }
      for (const link of tocList.querySelectorAll<HTMLElement>('.docshell__toc-link')) {
        link.classList.toggle('is-current', link.dataset.heading === activeHeading);
      }
    }, { root: scrollParent(root), rootMargin: '-8% 0px -70% 0px', threshold: 0 });
    for (const entry of entries) {
      const node = article.querySelector(`[id="${CSS.escape(entry.id)}"]`);
      if (node) headingSpy.observe(node);
    }
  }

  function paintPager(): void {
    pager.replaceChildren();
    const pages = flat();
    const at = pages.findIndex((item) => item.id === (page()?.id ?? ''));
    const previous = at > 0 ? pages[at - 1] : null;
    const next = at >= 0 && at < pages.length - 1 ? pages[at + 1] : null;
    pager.hidden = !previous && !next;

    for (const [item, way] of [[previous, 'Previous'], [next, 'Next']] as const) {
      if (!item) { pager.appendChild(el('span')); continue; }
      const link = el('button', `docshell__step docshell__step--${way.toLowerCase()}`);
      link.type = 'button';
      link.append(el('span', 'docshell__step-way', way), el('span', 'docshell__step-title', item.title));
      link.addEventListener('click', () => go(item.id));
      pager.appendChild(link);
    }
  }

  function paintBody(): void {
    sectionSpy?.disconnect();
    if (opts.mode === 'scroll') {
      article.replaceChildren();
      for (const item of opts.pages) {
        const block = el('section', 'docshell__section');
        block.dataset.page = item.id;
        block.innerHTML = renderDocMarkdown(item.markdown);
        article.appendChild(block);
      }
      heading.textContent = opts.title;
      sectionSpy = new IntersectionObserver((records) => {
        if (settle) return;
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const id = (record.target as HTMLElement).dataset.page;
          if (!id || id === current) break;
          current = id;
          paintRail();
          paintCrumbs();
          paintToc();
          opts.onNavigate(id);
          break;
        }
      }, { root: scrollParent(root), rootMargin: '-10% 0px -75% 0px', threshold: 0 });
      for (const block of article.querySelectorAll<HTMLElement>('.docshell__section')) sectionSpy.observe(block);
      return;
    }

    const here = page();
    if (!here) {
      heading.textContent = opts.title;
      article.replaceChildren();
      return;
    }
    const lifted = liftTitle(here);
    heading.textContent = lifted.title;
    article.innerHTML = renderDocMarkdown(lifted.body);
  }

  function paint(): void {
    // A page that has gone (a doc deleted between polls) hands the rail back to the first one.
    const pages = flat();
    if (!pages.some((item) => item.id === current)) current = pages[0]?.id ?? '';
    badge.textContent = opts.badge ?? '';
    badge.hidden = !opts.badge;
    paintBody();
    paintRail();
    paintCrumbs();
    paintToc();
    paintPager();
  }

  filterBox.addEventListener('input', () => { filter = filterBox.value; paintRail(); });

  // The two breakpoints. A container query styles them; this sets whether they start open, which
  // is the half CSS cannot do — and it watches the shell, not the window, because the sheet's
  // width changes without the window's when the chat docks beside it. It acts only when a
  // breakpoint is crossed: a height change, or a width change on the same side, must not undo a
  // reader who opened or closed one by hand. A zero width is a shell out of the document.
  let tocWide: boolean | null = null;
  let railWide: boolean | null = null;
  const sizes = new ResizeObserver((records) => {
    const width = records[0]?.contentRect.width ?? root.clientWidth;
    if (!width) return;
    if ((width > TOC_BREAK) !== tocWide) { tocWide = width > TOC_BREAK; toc.open = tocWide; }
    if ((width > RAIL_BREAK) !== railWide) { railWide = width > RAIL_BREAK; rail.open = railWide; }
  });
  sizes.observe(root);

  paint();

  return {
    root,
    update(next) {
      opts = { ...opts, ...next };
      if (next.current !== undefined) current = next.current;
      paint();
    },
    navigate(id) {
      go(id);
    },
    destroy() {
      releaseSpy();
      sizes.disconnect();
      headingSpy?.disconnect();
      sectionSpy?.disconnect();
      host.classList.remove('docshell-host');
      root.remove();
    },
  };
}
