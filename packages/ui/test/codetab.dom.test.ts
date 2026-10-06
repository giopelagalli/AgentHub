// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { Store } from '../src/store.js';
import type { ViewContext } from '../src/views/parts.js';

/**
 * The Code tab after decision 0072: one control (Files · Terminal · Preview · Browser), a quiet
 * editor, the toolbar's chat as the Guide; the map and the tour in Docs → How the code works.
 */

const MAP = '# Code map\n\n- `src/main.ts:3` — where it starts.\n- `src/util.ts:1` — a helper.\n- `src/util.ts:2` — another.\n';
const TREE = {
  truncated: false,
  entries: [
    { path: 'src', dir: true, size: 0, openable: false },
    { path: 'src/main.ts', dir: false, size: 40, openable: true },
    { path: 'src/util.ts', dir: false, size: 40, openable: true },
  ],
};

// A hub that answers only what these screens read; everything else stays pending.
vi.mock('../src/api.js', () => ({
  getJson: (url: string) => {
    if (url.endsWith('/code/tree')) return Promise.resolve(TREE);
    if (url.includes('/code/file?path=')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      return Promise.resolve({ path, text: 'one\ntwo\nthree\n', lines: 3 });
    }
    if (url.endsWith('/docs/code-map')) return Promise.resolve({ markdown: MAP });
    if (url.endsWith('/docs')) {
      return Promise.resolve({ index: 'Hello.', pages: [{ slug: 'code-map', title: 'Code map' }, { slug: 'arch', title: 'Architecture' }] });
    }
    if (url.endsWith('/docs/arch')) return Promise.resolve({ slug: 'arch', title: 'Architecture', markdown: '# Architecture\n\nBoxes.' });
    // The Guide's history: one reply that cites a line.
    if (url.endsWith('/chat/guide')) return Promise.resolve({ messages: [{ role: 'assistant', content: 'See `src/util.ts:2`.' }] });
    return new Promise(() => {});
  },
  sendJson: () => new Promise(() => {}),
}));

// CodeMirror stands in as a box that remembers what it was given and can report an edit.
const editors: { opened: string[]; line?: number; change: () => void }[] = [];
vi.mock('../src/code/editor.js', () => ({
  mountEditor: (_host: HTMLElement, opts: { onChange: () => void }) => {
    const record: { opened: string[]; line?: number; change: () => void } = { opened: [], change: opts.onChange };
    editors.push(record);
    return {
      open: (path: string) => { record.opened.push(path); },
      text: () => '',
      goToLine: (line: number) => { record.line = line; },
      markLines: () => {},
      destroy: () => {},
    };
  },
}));

afterEach(() => {
  document.body.replaceChildren();
  editors.length = 0;
});

/** Lets the mocked fetches and the editor's dynamic import land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const mountPage = async (): Promise<{ host: HTMLElement; dispose: () => void }> => {
  const { mountProjects } = await import('../src/pages/projects.js');
  const store = new Store();
  const project: ProjectManifest = {
    schema: 1, slug: 'acme', title: 'Acme', status: 'active', priority: 'project',
    intent: '', links: [], createdAt: 0, updatedAt: 0, index: [],
  };
  const hub: HubState = { nodes: [], agents: [], jobs: [], streams: {}, projects: [project] };
  store.dispatch({ type: 'hub-state', state: hub });
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { host, dispose: mountProjects(host, store) };
};

const pick = (host: HTMLElement, label: string, id: string): void =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"] [data-id="${id}"]`)?.click();

describe('the Code tab', () => {
  it('has one control of four parts and nothing else in its bar — no Map, Tour or Ask the guide', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'code');
    await settle();
    const bar = host.querySelector<HTMLElement>('.subbar')!;
    const options = [...bar.querySelectorAll<HTMLElement>('.seg__option')].map((o) => o.dataset.id);
    expect(options).toEqual(['files', 'terminal', 'preview', 'browser']);
    expect(bar.querySelectorAll('.seg')).toHaveLength(1);
    expect(bar.querySelector('.subbar__actions')?.children).toHaveLength(0);
    expect(host.textContent).not.toContain('Ask the guide');
    expect(host.textContent).not.toMatch(/\bMap\b|\bTour\b/);
    dispose();
  });

  it('makes the toolbar chat the Guide there, and the Manager everywhere else', async () => {
    const { host, dispose } = await mountPage();
    const chat = (): HTMLElement => host.querySelector<HTMLElement>('.toolbar [aria-pressed]')!;
    pick(host, 'Project sections', 'overview');
    expect(chat().getAttribute('aria-label')).toBe('Chat with the Manager');
    pick(host, 'Project sections', 'code');
    expect(chat().getAttribute('aria-label')).toBe('Chat with the Guide');
    chat().click();
    const pane = host.querySelector<HTMLElement>('.project__pane')!;
    expect(pane.hidden).toBe(false);
    expect(pane.textContent).toContain('Guide');
    expect(chat().getAttribute('aria-pressed')).toBe('true');
    chat().click();
    expect(pane.hidden).toBe(true);
    expect(chat().getAttribute('aria-pressed')).toBe('false');
    dispose();
  });
});

describe('the Files editor', () => {
  it('shows no header and no Save until a file is open, and Save only once it has unsaved changes', async () => {
    const { mountCode } = await import('../src/views/code.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const ctx = { slug: 'acme', title: 'Acme' } as unknown as ViewContext;
    const files = mountCode(host, ctx);
    await settle();
    const head = host.querySelector<HTMLElement>('.code__head')!;
    const save = [...head.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!;
    expect(head.hidden).toBe(true);
    expect(host.querySelector('.code__note')?.textContent).toBe('Choose a file to open it.');

    files.reveal('src/main.ts', 2);
    await settle();
    expect(head.hidden).toBe(false);
    expect(host.querySelector('.code__path')?.textContent).toBe('src/main.ts');
    expect(save.hidden).toBe(true);
    expect(editors).toHaveLength(1);
    expect(editors[0]?.line).toBe(2);

    editors[0]!.change();
    expect(save.hidden).toBe(false);
    files.dispose();
  });
});

describe('Docs → How the code works', () => {
  it('holds the map and its tour', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    const docs = [...host.querySelectorAll<HTMLElement>('[aria-label="Docs"] .seg__option')].map((o) => o.textContent);
    expect(docs).toEqual(['Pages', 'Media', 'How the code works']);
    pick(host, 'Docs', 'how');
    await settle();
    expect(host.querySelector('.code__map')?.textContent).toContain('Code map');

    const button = (text: string): HTMLButtonElement =>
      [...host.querySelectorAll<HTMLButtonElement>('.subbar__actions button')].find((b) => b.textContent === text)!;
    expect(button('Start tour').hidden).toBe(false);
    button('Start tour').click();
    expect(host.querySelector<HTMLElement>('.tour')!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('.code__map')!.hidden).toBe(true);
    expect(host.querySelector('.tour__count')?.textContent).toBe('Step 1 of 3');
    button('Back to the map').click();
    expect(host.querySelector<HTMLElement>('.code__map')!.hidden).toBe(false);
    dispose();
  });

  it('opens a map link in Code → Files, with the file open at its line', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    pick(host, 'Docs', 'how');
    await settle();
    host.querySelector<HTMLElement>('.code__map [data-path="src/main.ts"]')!.click();
    await settle();
    expect(host.querySelector('[aria-label="Project sections"] [aria-selected="true"]')?.getAttribute('data-id')).toBe('code');
    expect(host.querySelector('[aria-label="Code"] [aria-selected="true"]')?.getAttribute('data-id')).toBe('files');
    expect(host.querySelector('.code__path')?.textContent).toBe('src/main.ts');
    expect(editors.at(-1)?.opened).toContain('src/main.ts');
    expect(editors.at(-1)?.line).toBe(3);
    // The tree is opened down to the file, which is the row lit.
    expect(host.querySelector('.code__row[aria-current="true"]')?.getAttribute('data-path')).toBe('src/main.ts');
    dispose();
  });
});

/** The buttons in the bar under the toolbar, by their words. */
const barButton = (host: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('.subbar__actions button')].find((b) => b.textContent === text);
const tourButton = (host: HTMLElement, text: string): HTMLButtonElement =>
  [...host.querySelectorAll<HTMLButtonElement>('.tour button')].find((b) => b.textContent === text)!;
const selectedPart = (host: HTMLElement, label: string): string | null | undefined =>
  host.querySelector(`[aria-label="${label}"] [aria-selected="true"]`)?.getAttribute('data-id');
const pane = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.project__pane')!;
const chatButton = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.toolbar [aria-pressed]')!;

describe('leaving and coming back', () => {
  it('keeps the tour at the step that was left for the editor', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    pick(host, 'Docs', 'how');
    await settle();
    barButton(host, 'Start tour')!.click();
    tourButton(host, 'Next').click();
    tourButton(host, 'Next').click();
    expect(host.querySelector('.tour__count')?.textContent).toBe('Step 3 of 3');
    await settle();
    tourButton(host, 'Open in editor').click();
    await settle();
    expect(selectedPart(host, 'Project sections')).toBe('code');
    expect(host.querySelector('.code__path')?.textContent).toBe('src/util.ts');

    pick(host, 'Project sections', 'docs');
    await settle();
    expect(selectedPart(host, 'Docs')).toBe('how');
    expect(host.querySelector<HTMLElement>('.tour')!.hidden).toBe(false);
    expect(host.querySelector('.tour__count')?.textContent).toBe('Step 3 of 3');
    barButton(host, 'Back to the map')!.click();
    expect(barButton(host, 'Resume tour')?.hidden).toBe(false);
    barButton(host, 'Resume tour')!.click();
    expect(host.querySelector('.tour__count')?.textContent).toBe('Step 3 of 3');
    dispose();
  });

  it('asks before unsaved edits in Files are dropped, and a no stays put', async () => {
    // happy-dom has no dialogs: the owner's answer is stubbed in.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    pick(host, 'Docs', 'how');
    await settle();
    host.querySelector<HTMLElement>('.code__map [data-path="src/main.ts"]')!.click();
    await settle();
    editors.at(-1)!.change();

    pick(host, 'Project sections', 'docs');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(selectedPart(host, 'Project sections')).toBe('code');
    expect(host.querySelector('.code__path')?.textContent).toBe('src/main.ts');

    pick(host, 'Code', 'terminal');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(selectedPart(host, 'Code')).toBe('files');
    expect(host.querySelector('.code__path')?.textContent).toBe('src/main.ts');

    confirm.mockReturnValue(true);
    pick(host, 'Project sections', 'docs');
    expect(selectedPart(host, 'Project sections')).toBe('docs');
    expect(host.querySelector('.code__path')).toBeNull();
    vi.unstubAllGlobals();
    dispose();
  });
});

describe('the Guide', () => {
  it('opens from the tour with the lines in its box, and its citations land in Files beside it', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    pick(host, 'Docs', 'how');
    await settle();
    barButton(host, 'Start tour')!.click();
    await settle();
    tourButton(host, 'Ask about this').click();
    expect(pane(host).hidden).toBe(false);
    expect(pane(host).querySelector<HTMLInputElement>('.chat__form input')?.value).toMatch(/^About `src\/main\.ts:\d+`.*\(tour step 1\): $/);
    await settle();

    pane(host).querySelector<HTMLElement>('.md__ref[data-path="src/util.ts"]')!.click();
    await settle();
    expect(selectedPart(host, 'Project sections')).toBe('code');
    expect(selectedPart(host, 'Code')).toBe('files');
    expect(host.querySelector('.code__path')?.textContent).toBe('src/util.ts');
    expect(pane(host).hidden).toBe(false);
    expect(chatButton(host).getAttribute('aria-pressed')).toBe('true');
    dispose();
  });

  it('stays across Code\'s parts, and closes when Code is left, the button going back to the Manager', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'code');
    pick(host, 'Code', 'files');
    chatButton(host).click();
    expect(pane(host).hidden).toBe(false);
    pick(host, 'Code', 'preview');
    expect(pane(host).hidden).toBe(false);
    expect(chatButton(host).getAttribute('aria-pressed')).toBe('true');

    pick(host, 'Project sections', 'plan');
    expect(pane(host).hidden).toBe(true);
    expect(chatButton(host).getAttribute('aria-label')).toBe('Chat with the Manager');
    expect(chatButton(host).getAttribute('aria-pressed')).toBe('false');
    dispose();
  });
});

describe('Docs → Pages', () => {
  it('no longer lists the code map, which lives in How the code works', async () => {
    const { host, dispose } = await mountPage();
    pick(host, 'Project sections', 'docs');
    pick(host, 'Docs', 'pages');
    await settle();
    const links = [...host.querySelectorAll('.docshell__link')].map((n) => n.textContent);
    expect(links).toContain('Architecture');
    expect(links).toContain('Decision log');
    expect(links).not.toContain('Code map');
    dispose();
  });
});
