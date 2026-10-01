import { describe, it, expect } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { Store, chatKey, turnsOf, type BrowserFrame } from '../src/store.js';

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

const frame: BrowserFrame = { nodeName: 'macmini', slot: 0, leaseId: 'l1', jpegBase64: 'abc', at: 10 };

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
    expect(s.browserFrames).toEqual({});
  });

  it('browser-frame keeps only the newest frame of each slot', () => {
    const store = new Store();
    store.dispatch({ type: 'browser-frame', frame });
    expect(store.getState().browserFrames['macmini#0']).toEqual(frame);
    const newer = { ...frame, at: 11, jpegBase64: 'def' };
    const other = { ...frame, slot: 1, leaseId: 'l2' };
    store.dispatch({ type: 'browser-frame', frame: newer });
    store.dispatch({ type: 'browser-frame', frame: other });
    expect(store.getState().browserFrames).toEqual({ 'macmini#0': newer, 'macmini#1': other });
  });

  it('drops the last frame on leaving the computer page and keeps it on staying', () => {
    const store = new Store();
    store.dispatch({ type: 'set-page', page: 'computer' });
    store.dispatch({ type: 'browser-frame', frame });
    store.dispatch({ type: 'set-page', page: 'computer' });
    expect(store.getState().browserFrames['macmini#0']).toEqual(frame);
    store.dispatch({ type: 'set-page', page: 'cluster' });
    expect(store.getState().browserFrames).toEqual({});
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

  it('folds turn-event frames per project, and merges the fetched history under them', () => {
    const store = new Store();
    expect(turnsOf(store.getState(), 'acme')).toEqual({ state: 'loading', turns: [] });
    store.dispatch({ type: 'turn-event', frame: { slug: 'acme', sessionId: 1, at: 10, event: { kind: 'turn-start', who: 'manager' } } });
    store.dispatch({ type: 'turn-event', frame: { slug: 'beta', sessionId: 2, at: 11, event: { kind: 'turn-start', who: 'manager' } } });
    expect(turnsOf(store.getState(), 'acme').turns.map((t) => t.sessionId)).toEqual([1]);
    expect(turnsOf(store.getState(), 'beta').turns.map((t) => t.sessionId)).toEqual([2]);

    store.dispatch({
      type: 'turns-loaded', slug: 'acme',
      response: {
        running: null,
        turns: [{ sessionId: 3, startedAt: 1, endedAt: 5, outcome: 'done', summary: 'x', toolCalls: 0, cost: { usd: 0, tokens: 0 }, events: [] }],
        budget: { usedToday: 1, maxPerDay: 6, hubUsedToday: 3, hubMaxPerDay: 40 },
      },
    });
    const acme = turnsOf(store.getState(), 'acme');
    expect(acme.state).toBe('ready');
    expect(acme.turns.map((t) => t.sessionId)).toEqual([1, 3]);
    expect(acme.budget).toEqual({ usedToday: 1, maxPerDay: 6, hubUsedToday: 3, hubMaxPerDay: 40 });
    expect(turnsOf(store.getState(), 'beta').state).toBe('loading');
  });

  it('marks a failed turns fetch without dropping what the socket delivered, and never downgrades ready', () => {
    const store = new Store();
    store.dispatch({ type: 'turn-event', frame: { slug: 'acme', sessionId: 1, at: 10, event: { kind: 'turn-start', who: 'manager' } } });
    store.dispatch({ type: 'turns-failed', slug: 'acme' });
    expect(turnsOf(store.getState(), 'acme')).toMatchObject({ state: 'failed' });
    expect(turnsOf(store.getState(), 'acme').turns).toHaveLength(1);
    store.dispatch({ type: 'turns-loaded', slug: 'acme', response: { running: null, turns: [] } });
    store.dispatch({ type: 'turns-failed', slug: 'acme' });
    expect(turnsOf(store.getState(), 'acme').state).toBe('ready');
    expect(turnsOf(store.getState(), null).state).toBe('loading');
  });
});
