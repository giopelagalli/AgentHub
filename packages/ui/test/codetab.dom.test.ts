// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { Store } from '../src/store.js';
import type { ViewContext } from '../src/views/parts.js';

/**
 * The Code tab after decision 0072: one control (Files · Terminal · Preview · Browser), a quiet
 * editor, the toolbar's chat as the Guide; the map and the tour in Docs → How the code works.
 */

const MAP = '# Code map\n\n- `src/main.ts:3` — where it starts.\n';
const TREE = {
  truncated: false,
  entries: [
    { path: 'src', dir: true, size: 0, openable: false },
    { path: 'src/main.ts', dir: false, size: 40, openable: true },
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
    expect(host.querySelector('.tour__count')?.textContent).toBe('Step 1 of 1');
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
