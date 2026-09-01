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

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
}

/**
 * Live wiring: one REST snapshot, then the socket. While the socket is down the
 * store falls back to polling every 5s and a reconnect is attempted every 10s.
 */
export function connect(store: Store): void {
  let live: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setInterval> | undefined;

  const stopFallback = (): void => {
    clearInterval(pollTimer);
    clearInterval(reconnectTimer);
    pollTimer = undefined;
    reconnectTimer = undefined;
  };

  const startFallback = (): void => {
    if (pollTimer) return;
    store.dispatch({ type: 'connection', status: 'polling' });
    pollTimer = setInterval(() => {
      void fetchState(store).then((ok) =>
        store.dispatch({ type: 'connection', status: ok ? 'polling' : 'down' }),
      );
    }, POLL_MS);
    reconnectTimer = setInterval(open, RECONNECT_MS);
  };

  function open(): void {
    const socket = new WebSocket(socketUrl());
    socket.addEventListener('open', () => {
      live = socket;
      stopFallback();
      store.dispatch({ type: 'connection', status: 'live' });
    });
    socket.addEventListener('message', (event) => handleWsMessage(store, String(event.data)));
    socket.addEventListener('close', () => {
      if (live === socket) live = null;
      if (!live) startFallback();
    });
    socket.addEventListener('error', () => socket.close());
  }

  void fetchState(store);
  open();
}
