import { describe, it, expect } from 'vitest';
import type { HubState } from '@agenthub/shared';
import { applyHubState, handleWsMessage, shouldOpenSocket, shouldUsePoll } from '../src/net.js';
import { Store } from '../src/store.js';

const hubState: HubState = {
  nodes: [
    {
      id: 1,
      name: 'dev-node',
      arch: 'arm64',
      status: 'online',
      lastHeartbeat: 1,
      endpoints: [{ tier: 'worker', url: 'http://127.0.0.1:8102', model: 'mock-model', maxStreams: 8 }],
      jobTypes: [],
    },
  ],
  agents: [{ id: 7, name: 'scout', tier: 'worker', systemPrompt: 's' }],
  jobs: [],
  streams: { orchestrator: 0, worker: 2, vision: 0, 'video-gen': 0 },
};

// WebSocket.readyState values.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

describe('shouldUsePoll', () => {
  it('lets the poll own the connection status while no socket is open', () => {
    expect(shouldUsePoll(null)).toBe(true);
    expect(shouldUsePoll(CONNECTING)).toBe(true);
    expect(shouldUsePoll(CLOSING)).toBe(true);
    expect(shouldUsePoll(CLOSED)).toBe(true);
  });

  it('stands down as soon as a socket is open, so a late poll cannot demote it', () => {
    expect(shouldUsePoll(OPEN)).toBe(false);
  });
});

describe('shouldOpenSocket', () => {
  it('opens when nothing is in flight', () => {
    expect(shouldOpenSocket(null)).toBe(true);
    expect(shouldOpenSocket(CLOSED)).toBe(true);
    expect(shouldOpenSocket(CLOSING)).toBe(true);
  });

  it('refuses a second socket while one is connecting or open', () => {
    expect(shouldOpenSocket(CONNECTING)).toBe(false);
    expect(shouldOpenSocket(OPEN)).toBe(false);
  });
});

describe('applyHubState', () => {
  it('dispatches a valid payload into the store', () => {
    const store = new Store();
    expect(applyHubState(store, hubState)).toBe(true);
    expect(store.getState().hub).toEqual(hubState);
  });

  it('rejects payloads that are not hub state, leaving the store untouched', () => {
    const store = new Store();
    for (const bad of [null, undefined, 'nope', 42, {}, { nodes: [], agents: [], jobs: [] }]) {
      expect(applyHubState(store, bad)).toBe(false);
    }
    expect(store.getState().hub).toBeNull();
  });
});

describe('handleWsMessage', () => {
  it('applies state frames', () => {
    const store = new Store();
    handleWsMessage(store, JSON.stringify({ type: 'state', state: hubState }));
    expect(store.getState().hub).toEqual(hubState);
  });

  it('applies agent-busy frames in both directions', () => {
    const store = new Store();
    handleWsMessage(store, JSON.stringify({ type: 'state', state: hubState }));
    handleWsMessage(store, JSON.stringify({ type: 'agent-busy', agentId: 7, busy: true }));
    expect([...store.getState().busy]).toEqual([7]);
    handleWsMessage(store, JSON.stringify({ type: 'agent-busy', agentId: 7, busy: false }));
    expect([...store.getState().busy]).toEqual([]);
  });

  it('ignores malformed and unknown frames without throwing', () => {
    const store = new Store();
    let notifications = 0;
    store.subscribe(() => notifications++);
    for (const raw of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ type: 'weather', sunny: true }),
      JSON.stringify({ type: 'state' }),
      JSON.stringify({ type: 'agent-busy', agentId: 'seven', busy: true }),
      JSON.stringify({ type: 'agent-busy', agentId: 7 }),
    ]) {
      expect(() => handleWsMessage(store, raw)).not.toThrow();
    }
    expect(notifications).toBe(0);
    expect(store.getState().hub).toBeNull();
  });
});
