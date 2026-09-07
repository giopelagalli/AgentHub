import { describe, it, expect } from 'vitest';
import type { HubState } from '@agenthub/shared';
import { Store, type BrowserFrame } from '../src/store.js';

function fabricateHubState(agentIds: number[]): HubState {
  return {
    nodes: [],
    agents: agentIds.map((id) => ({ id, name: `agent-${id}`, tier: 'worker', systemPrompt: 's' })),
    jobs: [],
    streams: {},
  };
}

const frame: BrowserFrame = { nodeName: 'macmini', leaseId: 'l1', jpegBase64: 'abc', at: 10 };

describe('Store', () => {
  it('starts on floor f1 with connection down and empty hub/busy', () => {
    const store = new Store();
    const s = store.getState();
    expect(s.floor).toBe('f1');
    expect(s.connection).toBe('down');
    expect(s.hub).toBeNull();
    expect(s.busy.size).toBe(0);
    expect(s.browserFrame).toBeNull();
  });

  it('browser-frame keeps only the newest frame', () => {
    const store = new Store();
    store.dispatch({ type: 'browser-frame', frame });
    expect(store.getState().browserFrame).toEqual(frame);
    const next = { ...frame, jpegBase64: 'def', at: 11 };
    store.dispatch({ type: 'browser-frame', frame: next });
    expect(store.getState().browserFrame).toEqual(next);
  });

  it('drops the frame on leaving the screening room, and keeps it while staying', () => {
    const store = new Store();
    store.dispatch({ type: 'set-floor', floor: 'f5' });
    store.dispatch({ type: 'browser-frame', frame });
    store.dispatch({ type: 'set-floor', floor: 'f5' });
    expect(store.getState().browserFrame).toEqual(frame);
    store.dispatch({ type: 'set-floor', floor: 'f1' });
    expect(store.getState().browserFrame).toBeNull();
  });

  it('hub-state replaces hub and prunes busy ids no longer present in agents', () => {
    const store = new Store();
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: true });
    store.dispatch({ type: 'agent-busy', agentId: 2, busy: true });
    store.dispatch({ type: 'hub-state', state: fabricateHubState([1, 3]) });
    const s = store.getState();
    expect(s.hub?.agents.map((a) => a.id)).toEqual([1, 3]);
    expect([...s.busy].sort()).toEqual([1]);
  });

  it('agent-busy adds and removes ids from busy', () => {
    const store = new Store();
    store.dispatch({ type: 'agent-busy', agentId: 5, busy: true });
    expect(store.getState().busy.has(5)).toBe(true);
    store.dispatch({ type: 'agent-busy', agentId: 5, busy: false });
    expect(store.getState().busy.has(5)).toBe(false);
  });

  it('busy-reset clears busy without touching the rest of the state', () => {
    const store = new Store();
    store.dispatch({ type: 'agent-busy', agentId: 1, busy: true });
    store.dispatch({ type: 'agent-busy', agentId: 2, busy: true });
    store.dispatch({ type: 'set-floor', floor: 'ph' });
    store.dispatch({ type: 'busy-reset' });
    const s = store.getState();
    expect(s.busy.size).toBe(0);
    expect(s.floor).toBe('ph');
  });

  it('notifies subscribers on every dispatch, and unsubscribe stops notifications', () => {
    const store = new Store();
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count++;
    });
    store.dispatch({ type: 'set-floor', floor: 'b1' });
    store.dispatch({ type: 'connection', status: 'live' });
    expect(count).toBe(2);
    unsubscribe();
    store.dispatch({ type: 'set-floor', floor: 'ph' });
    expect(count).toBe(2);
  });

  it('set-floor and connection update state', () => {
    const store = new Store();
    store.dispatch({ type: 'set-floor', floor: 'ph' });
    store.dispatch({ type: 'connection', status: 'polling' });
    const s = store.getState();
    expect(s.floor).toBe('ph');
    expect(s.connection).toBe('polling');
  });

  it('hub-state keeps a still-live project floor selected', () => {
    const store = new Store();
    store.dispatch({ type: 'set-floor', floor: 'p:acme' });
    store.dispatch({
      type: 'hub-state',
      state: {
        ...fabricateHubState([]),
        projects: [
          {
            schema: 1, slug: 'acme', title: 'Acme', status: 'active', priority: 'project',
            intent: '', links: [], createdAt: 0, updatedAt: 0, index: [],
          },
        ],
      },
    });
    expect(store.getState().floor).toBe('p:acme');
  });

  it('hub-state falls back to f1 when the selected project floor disappears', () => {
    const store = new Store();
    store.dispatch({ type: 'set-floor', floor: 'p:acme' });
    store.dispatch({ type: 'hub-state', state: fabricateHubState([]) });
    expect(store.getState().floor).toBe('f1');
  });
});
