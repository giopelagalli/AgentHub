// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { Store } from '../src/store.js';
import type { ViewContext } from '../src/views/parts.js';

/**
 * The Browser view tells the store it is watching the cast for exactly as long as it is mounted —
 * on its own, and as the project page's Code part, where leaving it for Files stops the watch.
 */

// No hub behind the page: every read stays pending, and Files mounts nothing.
vi.mock('../src/api.js', () => ({
  getJson: () => new Promise(() => {}),
  sendJson: () => new Promise(() => {}),
}));
vi.mock('../src/views/code.js', () => ({ mountCode: () => ({ dispose: () => {}, reveal: () => {} }) }));

afterEach(() => { document.body.replaceChildren(); });

const ctx = { slug: 'acme', title: 'Acme' } as unknown as ViewContext;

describe('mountProjectBrowser', () => {
  it('watches the cast while mounted and stops on dispose', async () => {
    const { mountProjectBrowser } = await import('../src/views/browser.js');
    const store = new Store();
    const host = document.createElement('div');
    const dispose = mountProjectBrowser(host, ctx, store);
    expect(store.getState().projectBrowser).toBe(true);
    expect(host.textContent).toContain('No browser in use.');
    dispose();
    expect(store.getState().projectBrowser).toBe(false);
    expect(host.children).toHaveLength(0);
  });
});

describe('the Code tab', () => {
  it('stops watching when Browser gives way to Files', async () => {
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
    const dispose = mountProjects(host, store);
    const pick = (label: string, id: string): void =>
      host.querySelector<HTMLElement>(`[aria-label="${label}"] [data-id="${id}"]`)?.click();

    pick('Project sections', 'code');
    pick('Code', 'browser');
    expect(store.getState().projectBrowser).toBe(true);
    pick('Code', 'files');
    expect(store.getState().projectBrowser).toBe(false);
    dispose();
  });
});
