import { describe, it, expect } from 'vitest';
import type { HubState } from '@agenthub/shared';
import {
  applyHubState,
  BROWSER_TOPIC,
  handleWsMessage,
  shouldOpenSocket,
  shouldUsePoll,
  topicTransition,
} from '../src/net.js';
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

describe('topicTransition', () => {
  it('subscribes on arriving at the computer page and unsubscribes on leaving', () => {
    expect(topicTransition(null, 'computer')).toEqual({ type: 'subscribe', topic: BROWSER_TOPIC });
    expect(topicTransition('projects', 'computer')).toEqual({ type: 'subscribe', topic: BROWSER_TOPIC });
    expect(topicTransition('computer', 'cluster')).toEqual({ type: 'unsubscribe', topic: BROWSER_TOPIC });
  });

  it('says nothing when the computer page is neither entered nor left', () => {
    expect(topicTransition(null, 'projects')).toBeNull();
    expect(topicTransition('projects', 'allocation')).toBeNull();
    expect(topicTransition('computer', 'computer')).toBeNull();
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

  it('applies project-busy frames in both directions', () => {
    const store = new Store();
    handleWsMessage(store, JSON.stringify({ type: 'project-busy', slug: 'acme', who: 'manager', busy: true }));
    expect([...store.getState().projectBusy]).toEqual(['acme:manager']);
    handleWsMessage(store, JSON.stringify({ type: 'project-busy', slug: 'acme', who: 'manager', busy: false }));
    expect([...store.getState().projectBusy]).toEqual([]);
  });

  it('applies browser-frame frames, defaulting a missing lease to null', () => {
    const store = new Store();
    handleWsMessage(store, JSON.stringify({
      type: 'browser-frame', nodeName: 'macmini', leaseId: 'l1', jpegBase64: 'abc', at: 5,
    }));
    expect(store.getState().browserFrame).toEqual({
      nodeName: 'macmini', leaseId: 'l1', jpegBase64: 'abc', at: 5,
    });
    handleWsMessage(store, JSON.stringify({
      type: 'browser-frame', nodeName: 'macmini', leaseId: null, jpegBase64: 'def', at: 6,
    }));
    expect(store.getState().browserFrame?.leaseId).toBeNull();
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
      JSON.stringify({ type: 'project-busy', slug: 'acme', busy: true }),
      JSON.stringify({ type: 'project-busy', slug: 'acme', who: 'manager' }),
      JSON.stringify({ type: 'browser-frame', nodeName: 'macmini', at: 1 }),
      JSON.stringify({ type: 'browser-frame', jpegBase64: 'abc', at: 1 }),
      JSON.stringify({ type: 'browser-frame', nodeName: 'macmini', jpegBase64: 'abc' }),
    ]) {
      expect(() => handleWsMessage(store, raw)).not.toThrow();
    }
    expect(notifications).toBe(0);
    expect(store.getState().hub).toBeNull();
    expect(store.getState().browserFrame).toBeNull();
    expect(store.getState().projectBusy.size).toBe(0);
  });
});
