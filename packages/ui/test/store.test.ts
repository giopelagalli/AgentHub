import { describe, it, expect } from 'vitest';
import type { HubState } from '@agenthub/shared';
import { Store } from '../src/store.js';

function fabricateHubState(agentIds: number[]): HubState {
  return {
    nodes: [],
    agents: agentIds.map((id) => ({ id, name: `agent-${id}`, tier: 'worker', systemPrompt: 's' })),
    jobs: [],
    streams: {},
  };
}

describe('Store', () => {
  it('starts on floor f1 with connection down and empty hub/busy', () => {
    const store = new Store();
    const s = store.getState();
    expect(s.floor).toBe('f1');
    expect(s.connection).toBe('down');
    expect(s.hub).toBeNull();
    expect(s.busy.size).toBe(0);
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
    store.dispatch({ type: 'set-floor', floor: 'f3' });
    store.dispatch({ type: 'connection', status: 'polling' });
    const s = store.getState();
    expect(s.floor).toBe('f3');
    expect(s.connection).toBe('polling');
  });
});
