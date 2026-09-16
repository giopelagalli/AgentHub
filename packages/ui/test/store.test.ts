import { describe, it, expect } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { Store, chatKey, type BrowserFrame } from '../src/store.js';

function project(slug: string): ProjectManifest {
  return {
    schema: 1, slug, title: slug, status: 'active', priority: 'project',
    intent: '', links: [], createdAt: 0, updatedAt: 0, index: [],
  };
}

function fabricateHubState(agentIds: number[], slugs: string[] = []): HubState {
  return {
    nodes: [],
    agents: agentIds.map((id) => ({ id, name: `agent-${id}`, tier: 'worker', systemPrompt: 's' })),
    jobs: [],
    streams: {},
    projects: slugs.map(project),
  };
}

const frame: BrowserFrame = { nodeName: 'macmini', leaseId: 'l1', jpegBase64: 'abc', at: 10 };

describe('Store', () => {
  it('starts on the projects page with no project, connection down and nothing busy', () => {
    const s = new Store().getState();
    expect(s.page).toBe('projects');
    expect(s.project).toBeNull();
    expect(s.prdSeed).toBeNull();
    expect(s.connection).toBe('down');
    expect(s.hub).toBeNull();
    expect(s.busy.size).toBe(0);
    expect(s.projectBusy.size).toBe(0);
    expect(s.browserFrame).toBeNull();
  });

  it('browser-frame keeps only the newest frame', () => {
    const store = new Store();
    store.dispatch({ type: 'browser-frame', frame });
    expect(store.getState().browserFrame).toEqual(frame);
    const newer = { ...frame, at: 11, jpegBase64: 'def' };
    store.dispatch({ type: 'browser-frame', frame: newer });
    expect(store.getState().browserFrame).toEqual(newer);
  });

  it('drops the last frame on leaving the computer page and keeps it on staying', () => {
    const store = new Store();
    store.dispatch({ type: 'set-page', page: 'computer' });
    store.dispatch({ type: 'browser-frame', frame });
    store.dispatch({ type: 'set-page', page: 'computer' });
    expect(store.getState().browserFrame).toEqual(frame);
    store.dispatch({ type: 'set-page', page: 'cluster' });
    expect(store.getState().browserFrame).toBeNull();
  });

  it('adds and removes busy agents', () => {
    const store = new Store();
    store.dispatch({ type: 'hub-state', state: fabricateHubState([1, 2]) });
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: true });
    store.dispatch({ type: 'agent-busy', agentId: 2, busy: true });
    expect([...store.getState().busy].sort()).toEqual([1, 2]);
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: false });
    expect([...store.getState().busy]).toEqual([2]);
  });

  it('forgets busy agents the hub no longer reports', () => {
    const store = new Store();
    store.dispatch({ type: 'hub-state', state: fabricateHubState([1, 2]) });
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: true });
    store.dispatch({ type: 'agent-busy', agentId: 2, busy: true });
    store.dispatch({ type: 'hub-state', state: fabricateHubState([2]) });
    expect([...store.getState().busy]).toEqual([2]);
  });

  it('keys project-busy by slug and who, and busy-reset clears both sets', () => {
    const store = new Store();
    store.dispatch({ type: 'hub-state', state: fabricateHubState([1]) });
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: true });
    store.dispatch({ type: 'project-busy', slug: 'acme', who: 'coder-1', busy: true });
    store.dispatch({ type: 'project-busy', slug: 'acme', who: 'manager', busy: true });
    expect(store.getState().projectBusy.has(chatKey('acme', 'coder-1'))).toBe(true);
    store.dispatch({ type: 'project-busy', slug: 'acme', who: 'coder-1', busy: false });
    expect([...store.getState().projectBusy]).toEqual(['acme:manager']);
    store.dispatch({ type: 'busy-reset' });
    expect(store.getState().busy.size).toBe(0);
    expect(store.getState().projectBusy.size).toBe(0);
  });

  it('selects the first project the hub reports, and keeps a selection that survives', () => {
    const store = new Store();
    store.dispatch({ type: 'hub-state', state: fabricateHubState([], ['acme', 'beta']) });
    expect(store.getState().project).toBe('acme');
    store.dispatch({ type: 'set-project', slug: 'beta' });
    store.dispatch({ type: 'hub-state', state: fabricateHubState([], ['acme', 'beta']) });
    expect(store.getState().project).toBe('beta');
  });

  it('falls back to the first project when the selected one goes away', () => {
    const store = new Store();
    store.dispatch({ type: 'hub-state', state: fabricateHubState([], ['acme', 'beta']) });
    store.dispatch({ type: 'set-project', slug: 'beta' });
    store.dispatch({ type: 'hub-state', state: fabricateHubState([], ['acme']) });
    expect(store.getState().project).toBe('acme');
    store.dispatch({ type: 'hub-state', state: fabricateHubState([], []) });
    expect(store.getState().project).toBeNull();
  });

  it('holds a just-drafted PRD until the project view takes it', () => {
    const store = new Store();
    store.dispatch({ type: 'prd-drafted', slug: 'acme', questions: ['Who is it for?'] });
    expect(store.getState().prdSeed).toEqual({ slug: 'acme', questions: ['Who is it for?'] });
    store.dispatch({ type: 'prd-seed-taken' });
    expect(store.getState().prdSeed).toBeNull();
  });

  it('notifies subscribers until they unsubscribe', () => {
    const store = new Store();
    let seen = 0;
    const stop = store.subscribe(() => seen++);
    store.dispatch({ type: 'connection', status: 'live' });
    expect(seen).toBe(1);
    expect(store.getState().connection).toBe('live');
    stop();
    store.dispatch({ type: 'connection', status: 'down' });
    expect(seen).toBe(1);
  });
});
