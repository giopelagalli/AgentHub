import type { HubState } from '@agenthub/shared';
import type { Store } from './store.js';

const STATE_URL = '/api/state';
const POLL_MS = 5000;
const RECONNECT_MS = 10000;

function isHubState(value: unknown): value is HubState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.jobs) &&
    typeof candidate.streams === 'object' &&
    candidate.streams !== null
  );
}

/** Dispatches a hub-state payload of unknown provenance; false if it was not one. */
export function applyHubState(store: Store, payload: unknown): boolean {
  if (!isHubState(payload)) return false;
  store.dispatch({ type: 'hub-state', state: payload });
  return true;
}

/** Pure half of the socket: a raw frame in, store dispatches out. Bad frames are dropped. */
export function handleWsMessage(store: Store, raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null) return;
  const frame = message as Record<string, unknown>;

  if (frame.type === 'state') {
    applyHubState(store, frame.state);
    return;
  }
  if (frame.type === 'agent-busy' && typeof frame.agentId === 'number' && typeof frame.busy === 'boolean') {
    store.dispatch({ type: 'agent-busy', agentId: frame.agentId, busy: frame.busy });
  }
}

async function fetchState(store: Store): Promise<boolean> {
  try {
    const response = await fetch(STATE_URL);
    return response.ok && applyHubState(store, await response.json());
  } catch {
    return false;
  }
}

// WebSocket.readyState values, spelled out so this module stays runnable in node.
const CONNECTING = 0;
const OPEN = 1;

/**
 * A poll result may only speak for the connection status while no socket is
 * open. Checked both before the fetch and after it resolves, so a socket that
 * comes back mid-flight is not demoted to 'polling' by the late answer.
 */
export function shouldUsePoll(socketReadyState: number | null): boolean {
  return socketReadyState !== OPEN;
}

/**
 * Only one socket at a time: a handshake that outlives the reconnect interval
 * must not be joined by a second attempt, or both would deliver every frame.
 */
export function shouldOpenSocket(socketReadyState: number | null): boolean {
  return socketReadyState !== CONNECTING && socketReadyState !== OPEN;
}

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
}

/**
 * Live wiring: one REST snapshot, then the socket. While the socket is down the
 * store falls back to polling every 5s and a reconnect is attempted every 10s.
 */
export function connect(store: Store): void {
  /** The one socket this client owns, from construction until it closes. */
  let current: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setInterval> | undefined;

  const readyState = (): number | null => current?.readyState ?? null;

  const stopFallback = (): void => {
    clearInterval(pollTimer);
    clearInterval(reconnectTimer);
    pollTimer = undefined;
    reconnectTimer = undefined;
  };

  const poll = async (): Promise<void> => {
    if (!shouldUsePoll(readyState())) return;
    const ok = await fetchState(store);
    if (!shouldUsePoll(readyState())) return;
    store.dispatch({ type: 'connection', status: ok ? 'polling' : 'down' });
  };

  const startFallback = (): void => {
    if (pollTimer) return;
    store.dispatch({ type: 'connection', status: 'polling' });
    pollTimer = setInterval(() => void poll(), POLL_MS);
    reconnectTimer = setInterval(open, RECONNECT_MS);
  };

  function open(): void {
    if (!shouldOpenSocket(readyState())) return;
    const socket = new WebSocket(socketUrl());
    current = socket;
    socket.addEventListener('open', () => {
      stopFallback();
      // A fresh connect replays busy state from scratch; drop anything stale
      // from before it, so a busy agent that finished while we were down
      // doesn't stay stuck busy forever.
      store.dispatch({ type: 'busy-reset' });
      store.dispatch({ type: 'connection', status: 'live' });
    });
    socket.addEventListener('message', (event) => handleWsMessage(store, String(event.data)));
    socket.addEventListener('close', () => {
      if (current !== socket) return;
      current = null;
      startFallback();
    });
    socket.addEventListener('error', () => socket.close());
  }

  void fetchState(store);
  open();
}
