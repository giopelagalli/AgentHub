// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDocShell, type DocPage, type DocShellHandle, type DocShellOptions } from '../src/panels/docshell.js';

/**
 * The docs shell in a DOM (happy-dom, this file only — decision 0052). The two observers are
 * stubbed: happy-dom does no layout, so the tests drive their callbacks by hand.
 */

class FakeIntersection {
  static all: FakeIntersection[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback, readonly init: IntersectionObserverInit = {}) {
    FakeIntersection.all.push(this);
  }
  observe(node: Element): void { this.observed.push(node); }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  fire(target: Element): void {
    this.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as never);
  }
}

class FakeResize {
  static all: FakeResize[] = [];
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) { FakeResize.all.push(this); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void { this.disconnected = true; }
  fire(width: number, height = 600): void {
    this.callback([{ contentRect: { width, height } } as unknown as ResizeObserverEntry], this as never);
  }
}

const PAGES: DocPage[] = [
  { id: 'intro', title: 'Intro', section: 'Guides', markdown: '# Intro\n\nHello.\n\n## Setup\n\nSteps.' },
  { id: 'usage', title: 'Usage', section: 'Guides', markdown: 'Use it.' },
  { id: 'api', title: 'API', section: 'Reference', markdown: 'Endpoints.' },
];

function mount(extra: Partial<DocShellOptions> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onNavigate = vi.fn<(id: string) => void>();
  let handle: DocShellHandle | null = null;
  handle = mountDocShell(host, {
    pages: PAGES,
    current: 'intro',
    title: 'Docs',
    // A view answers a page-mode navigation by handing the new page back, as the Docs sheet does.
    onNavigate: (id) => { onNavigate(id); if (extra.mode !== 'scroll') handle?.update({ current: id }); },
    ...extra,
  });
  const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T & Element>(selector);
  const links = () => [...host.querySelectorAll<HTMLButtonElement>('.docshell__link')];
  const link = (title: string) => links().find((item) => item.textContent === title)!;
  const currentLink = () => host.querySelector('.docshell__link[aria-current="page"]')?.textContent;
  return { host, handle, onNavigate, q, links, link, currentLink };
}

beforeEach(() => {
  FakeIntersection.all = [];
  FakeResize.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersection);
  vi.stubGlobal('ResizeObserver', FakeResize);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('mountDocShell — page mode', () => {
  it('draws the rail by section, lights the current page and titles it', () => {
    const { host, q, links, currentLink } = mount();
    expect([...host.querySelectorAll('.docshell__group-head')].map((n) => n.textContent)).toEqual(['Guides', 'Reference']);
    expect(links().map((n) => n.textContent)).toEqual(['Intro', 'Usage', 'API']);
    expect(currentLink()).toBe('Intro');
    expect(q('h1')?.textContent).toBe('Intro');
    expect([...host.querySelectorAll('.docshell__toc-link')].map((n) => n.textContent)).toEqual(['Setup']);
  });

  it('navigates on a rail click: callback, title, breadcrumb and highlight follow', () => {
    const { host, q, link, onNavigate, currentLink } = mount();
    link('API').click();
    expect(onNavigate).toHaveBeenCalledWith('api');
    expect(q('h1')?.textContent).toBe('API');
    expect(currentLink()).toBe('API');
    const crumbs = [...host.querySelectorAll('.docshell__crumbs .docshell__crumb')].map((n) => n.textContent);
    expect(crumbs).toEqual(['Docs', 'Reference', 'API']);
  });

  it('steps through the pages with the pager', () => {
    const { q, onNavigate } = mount();
    expect(q('.docshell__step--previous')).toBeNull();
    q<HTMLButtonElement>('.docshell__step--next')!.click();
    expect(onNavigate).toHaveBeenLastCalledWith('usage');
    expect(q('.docshell__step--previous .docshell__step-title')?.textContent).toBe('Intro');
    expect(q('.docshell__step--next .docshell__step-title')?.textContent).toBe('API');
    q<HTMLButtonElement>('.docshell__step--next')!.click();
    expect(q('.docshell__step--next')).toBeNull();
    q<HTMLButtonElement>('.docshell__step--previous')!.click();
    expect(onNavigate).toHaveBeenLastCalledWith('usage');
  });

  it('filters the rail by title, and says so when nothing matches', () => {
    const { q, links } = mount();
    const box = q<HTMLInputElement>('.docshell__filter')!;
    box.value = 'ap';
    box.dispatchEvent(new Event('input'));
    expect(links().map((n) => n.textContent)).toEqual(['API']);
    box.value = 'nothing like it';
    box.dispatchEvent(new Event('input'));
    expect(links()).toHaveLength(0);
    expect(q('.docshell__none')?.textContent).toBe('No page matches.');
  });

  it('navigate(id) goes the way a rail click does, and is a no-op for the page already open', () => {
    const { handle, onNavigate, q } = mount();
    handle!.navigate('intro');
    expect(onNavigate).not.toHaveBeenCalled();
    handle!.navigate('usage');
    expect(onNavigate).toHaveBeenCalledWith('usage');
    expect(q('h1')?.textContent).toBe('Usage');
  });

  it('opens and closes the rails only when a width breakpoint is crossed', () => {
    const { q } = mount();
    const toc = q<HTMLDetailsElement>('.docshell__toc')!;
    const rail = q<HTMLDetailsElement>('.docshell__rail')!;
    const sizes = FakeResize.all[0];
    sizes.fire(1200);
    expect(toc.open).toBe(true);
    toc.open = false; // the reader folds it away
    sizes.fire(1200, 900); // a height change
    sizes.fire(1300); // wider, same side of the line
    expect(toc.open).toBe(false);
    sizes.fire(900);
    expect([toc.open, rail.open]).toEqual([false, true]);
    toc.open = true; // and opens it again below the line
    sizes.fire(950);
    expect(toc.open).toBe(true);
    sizes.fire(700);
    expect(rail.open).toBe(false);
    sizes.fire(0); // out of the document: no verdict
    expect(rail.open).toBe(false);
  });

  it('destroy disconnects every observer and takes the shell out of its host', () => {
    const { host, handle } = mount();
    handle!.destroy();
    expect(FakeResize.all.every((o) => o.disconnected)).toBe(true);
    expect(FakeIntersection.all.length).toBeGreaterThan(0);
    expect(FakeIntersection.all.every((o) => o.disconnected)).toBe(true);
    expect(host.querySelector('.docshell-box')).toBeNull();
    expect(host.classList.contains('docshell-host')).toBe(false);
  });

  it('renders a hostile callout title as text, not markup', () => {
    const { q } = mount({
      pages: [{ id: 'bad', title: 'Bad', markdown: ':::warning <img onerror=x>\nCareful.\n:::' }],
      current: 'bad',
    });
    const article = q('article')!;
    expect(article.querySelector('img')).toBeNull();
    expect(article.querySelector('.adm--warning')?.textContent).toContain('<img onerror=x>');
  });
});

describe('mountDocShell — scroll mode', () => {
  const sectionSpy = () => FakeIntersection.all.find((o) => !o.disconnected && o.init.rootMargin === '-10% 0px -75% 0px')!;

  it('holds the section spy after a rail jump until scrolling settles', () => {
    vi.useFakeTimers();
    const { host, link, onNavigate, currentLink } = mount({ mode: 'scroll', title: 'Guide' });
    const usage = host.querySelector('[data-page="usage"]')!;

    link('API').click();
    expect(onNavigate).toHaveBeenLastCalledWith('api');
    sectionSpy().fire(usage); // the short last section never reaches the band; the one above does
    expect(currentLink()).toBe('API');

    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(100);
    sectionSpy().fire(usage); // still scrolling: the timer was re-armed
    expect(currentLink()).toBe('API');

    vi.advanceTimersByTime(200);
    sectionSpy().fire(usage);
    expect(currentLink()).toBe('Usage');
    expect(onNavigate).toHaveBeenLastCalledWith('usage');
  });
});
