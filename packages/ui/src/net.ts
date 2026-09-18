import type { HubState } from '@agenthub/shared';
import type { PageId } from './rail.js';
import type { Store } from './store.js';
import type { TurnEvent } from './turns.js';

const TURN_EVENT_KINDS = new Set<TurnEvent['kind']>([
  'turn-start', 'text', 'tool-call', 'tool-result', 'subagent-start', 'subagent-end', 'verify', 'turn-end',
]);

/** True for anything shaped like one of the turn events — the panel tolerates loose fields. */
function isTurnEvent(value: unknown): value is TurnEvent {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' && TURN_EVENT_KINDS.has(kind as TurnEvent['kind']);
}

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

/** The hub only casts the browser screen to sockets that asked for this topic. */
export const BROWSER_TOPIC = 'browser';

/** The one page that watches the cast. */
const BROWSER_PAGE: PageId = 'computer';

export interface TopicMessage {
  type: 'subscribe' | 'unsubscribe';
  topic: string;
}

/**
 * The topic message a page change owes the hub, or null when it owes none:
 * screencast frames are big, so the client subscribes on arriving at the
 * computer page and unsubscribes on leaving. `before` is the page this socket
 * was last told about — null for a socket that has said nothing yet.
 */
export function topicTransition(before: PageId | null, after: PageId): TopicMessage | null {
  const wants = after === BROWSER_PAGE;
  if (wants === (before === BROWSER_PAGE)) return null;
  return { type: wants ? 'subscribe' : 'unsubscribe', topic: BROWSER_TOPIC };
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
    return;
  }
  if (
    frame.type === 'project-busy'
    && typeof frame.slug === 'string'
    && typeof frame.who === 'string'
    && typeof frame.busy === 'boolean'
  ) {
    store.dispatch({ type: 'project-busy', slug: frame.slug, who: frame.who, busy: frame.busy });
    return;
  }
  if (
    frame.type === 'turn-event'
    && typeof frame.slug === 'string'
    && typeof frame.sessionId === 'string'
    && typeof frame.at === 'number'
    && isTurnEvent(frame.event)
  ) {
    store.dispatch({
      type: 'turn-event',
      frame: { slug: frame.slug, sessionId: frame.sessionId, at: frame.at, event: frame.event },
    });
    return;
  }
  if (
    frame.type === 'browser-frame'
    && typeof frame.jpegBase64 === 'string'
    && typeof frame.nodeName === 'string'
    && typeof frame.at === 'number'
  ) {
    store.dispatch({
      type: 'browser-frame',
      frame: {
        nodeName: frame.nodeName,
        leaseId: typeof frame.leaseId === 'string' ? frame.leaseId : null,
        jpegBase64: frame.jpegBase64,
        at: frame.at,
      },
    });
  }
}

/** A poll either landed, failed, or found the session gone — the last is not the hub being down. */
type PollResult = 'ok' | 'down' | 'expired';

async function fetchState(store: Store): Promise<PollResult> {
  try {
    // The session cookie is what authenticates this poll (and the socket, which sends it itself).
    const response = await fetch(STATE_URL, { credentials: 'same-origin' });
    if (response.status === 401) return 'expired';
    return response.ok && applyHubState(store, await response.json()) ? 'ok' : 'down';
  } catch {
    return 'down';
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
  /** The page the open socket has been told about; null while no socket is up. */
  let announcedPage: PageId | null = null;

  const readyState = (): number | null => current?.readyState ?? null;

  const stopFallback = (): void => {
    clearInterval(pollTimer);
    clearInterval(reconnectTimer);
    pollTimer = undefined;
    reconnectTimer = undefined;
  };

  /**
   * A 30-day cookie expires mid-session sooner or later. Reloading hands the page back to `boot`,
   * which asks `/api/me` and puts the login box up — without this the app just sits on 'down'.
   */
  const relogin = (): void => {
    stopFallback();
    current?.close();
    window.location.reload();
  };

  const poll = async (): Promise<void> => {
    if (!shouldUsePoll(readyState())) return;
    const result = await fetchState(store);
    if (result === 'expired') return relogin();
    if (!shouldUsePoll(readyState())) return;
    store.dispatch({ type: 'connection', status: result === 'ok' ? 'polling' : 'down' });
  };

  const syncTopics = (): void => {
    const socket = current;
    if (!socket || socket.readyState !== OPEN) return;
    const page = store.getState().page;
    const message = topicTransition(announcedPage, page);
    announcedPage = page;
    if (message) socket.send(JSON.stringify(message));
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
      // A new socket carries no subscriptions, whatever the last one had asked for.
      announcedPage = null;
      syncTopics();
    });
    socket.addEventListener('message', (event) => handleWsMessage(store, String(event.data)));
    socket.addEventListener('close', () => {
      if (current !== socket) return;
      current = null;
      announcedPage = null;
      startFallback();
    });
    socket.addEventListener('error', () => socket.close());
  }

  store.subscribe(syncTopics);
  void fetchState(store);
  open();
}
