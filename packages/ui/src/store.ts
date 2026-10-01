import type { HubState, TurnBudget } from '@agenthub/shared';
import type { PageId } from './rail.js';
import { applyTurnEvent, mergeTurns, type TurnFrame, type TurnRecord, type TurnsResponse, type TurnsState } from './turns.js';

/** One project's turns: what `/turns` said plus everything the socket has appended since. */
export interface ProjectTurns {
  state: TurnsState;
  turns: TurnRecord[];
  /** The turn cap as of the last `/turns` fetch; absent until one has landed. */
  budget?: TurnBudget;
}

const NO_TURNS: ProjectTurns = { state: 'loading', turns: [] };

/** The turns held for `slug`, or an empty loading set for a project nothing has arrived for yet. */
export function turnsOf(state: UiState, slug: string | null): ProjectTurns {
  return (slug ? state.turns[slug] : undefined) ?? NO_TURNS;
}

/** One screencast frame off the `browser` topic; `jpegBase64` is decoded by the page. */
export interface BrowserFrame {
  nodeName: string;
  /** The pool slot on `nodeName` it shows; 0 from a hub that predates the pool. */
  slot: number;
  leaseId: string | null;
  jpegBase64: string;
  at: number;
}

/** Key for `browserFrames`: one slot of the browser pool. */
export const slotKey = (node: string, slot: number): string => `${node}#${slot}`;

/** Whether anything on screen watches the browser cast: the computer page, or a project's Browser view. */
export function wantsCast(state: Pick<UiState, 'page' | 'projectBrowser'>): boolean {
  return state.page === 'computer' || state.projectBrowser;
}

/** Key for the `projectBusy` set: one project agent in one project. */
export function chatKey(slug: string, who: string): string {
  return `${slug}:${who}`;
}

export interface UiState {
  hub: HubState | null;
  /** Global agent ids mid-reply. */
  busy: Set<number>;
  /** `slug:who` of the project agents mid-reply in a one-on-one chat. */
  projectBusy: Set<string>;
  page: PageId;
  /** Slug selected in the rail; null when the hub has no project to show. */
  project: string | null;
  /** A PRD the wizard has just drafted, waiting for the project view to open it. */
  prdSeed: { slug: string; questions: string[] } | null;
  connection: 'live' | 'polling' | 'down';
  /** A project's Code → Browser view is on screen: it watches the cast as the computer page does. */
  projectBrowser: boolean;
  /** The newest frame of every slot being cast, by `slotKey`; empty whenever nothing watches the cast. */
  browserFrames: Record<string, BrowserFrame>;
  /** Per project slug: its recent turns, the running one included. */
  turns: Record<string, ProjectTurns>;
}

export type StoreEvent =
  | { type: 'hub-state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean }
  | { type: 'project-busy'; slug: string; who: string; busy: boolean }
  | { type: 'busy-reset' }
  | { type: 'set-page'; page: PageId }
  | { type: 'set-project'; slug: string }
  | { type: 'prd-drafted'; slug: string; questions: string[] }
  | { type: 'prd-seed-taken' }
  | { type: 'project-browser'; open: boolean }
  | { type: 'browser-frame'; frame: BrowserFrame }
  | { type: 'turn-event'; frame: TurnFrame }
  | { type: 'turns-loaded'; slug: string; response: TurnsResponse }
  | { type: 'turns-failed'; slug: string }
  | { type: 'connection'; status: UiState['connection'] };

export class Store {
  private state: UiState = {
    hub: null,
    busy: new Set(),
    projectBusy: new Set(),
    page: 'projects',
    project: null,
    prdSeed: null,
    connection: 'down',
    projectBrowser: false,
    browserFrames: {},
    turns: {},
  };
  private listeners = new Set<(s: UiState) => void>();

  getState(): UiState {
    return this.state;
  }

  dispatch(event: StoreEvent): void {
    switch (event.type) {
      case 'hub-state': {
        const agentIds = new Set(event.state.agents.map((a) => a.id));
        const busy = new Set([...this.state.busy].filter((id) => agentIds.has(id)));
        // A project that finished (or was deleted) can't stay selected under the
        // viewer; fall back to the first one the hub still reports.
        const slugs = (event.state.projects ?? []).map((p) => p.slug);
        const project = this.state.project && slugs.includes(this.state.project)
          ? this.state.project
          : (slugs[0] ?? null);
        this.state = { ...this.state, hub: event.state, busy, project };
        break;
      }
      case 'agent-busy': {
        const busy = new Set(this.state.busy);
        if (event.busy) busy.add(event.agentId);
        else busy.delete(event.agentId);
        this.state = { ...this.state, busy };
        break;
      }
      case 'project-busy': {
        const projectBusy = new Set(this.state.projectBusy);
        const key = chatKey(event.slug, event.who);
        if (event.busy) projectBusy.add(key);
        else projectBusy.delete(key);
        this.state = { ...this.state, projectBusy };
        break;
      }
      case 'busy-reset':
        this.state = { ...this.state, busy: new Set(), projectBusy: new Set() };
        break;
      // When nothing watches the cast any more the last frames go: the cast stops with the
      // unsubscribe, and coming back to a frozen still would read as live.
      case 'set-page':
      case 'project-browser': {
        const next = event.type === 'set-page'
          ? { ...this.state, page: event.page }
          : { ...this.state, projectBrowser: event.open };
        this.state = wantsCast(next) ? next : { ...next, browserFrames: {} };
        break;
      }
      case 'set-project':
        this.state = { ...this.state, project: event.slug };
        break;
      case 'prd-drafted':
        this.state = { ...this.state, prdSeed: { slug: event.slug, questions: event.questions } };
        break;
      case 'prd-seed-taken':
        this.state = { ...this.state, prdSeed: null };
        break;
      case 'browser-frame': {
        // A frame still in flight after the unsubscribe would otherwise outlive the drop.
        if (!wantsCast(this.state)) break;
        const key = slotKey(event.frame.nodeName, event.frame.slot);
        this.state = { ...this.state, browserFrames: { ...this.state.browserFrames, [key]: event.frame } };
        break;
      }
      case 'turn-event': {
        const held = turnsOf(this.state, event.frame.slug);
        const turns = applyTurnEvent(held.turns, event.frame);
        this.state = { ...this.state, turns: { ...this.state.turns, [event.frame.slug]: { ...held, turns } } };
        break;
      }
      case 'turns-loaded': {
        const held = turnsOf(this.state, event.slug);
        const turns = mergeTurns(held.turns, event.response);
        this.state = {
          ...this.state,
          turns: { ...this.state.turns, [event.slug]: { state: 'ready', turns, budget: event.response.budget } },
        };
        break;
      }
      // A failed fetch keeps whatever the socket delivered: the list can still show those.
      case 'turns-failed': {
        const held = turnsOf(this.state, event.slug);
        if (held.state === 'ready') break;
        this.state = { ...this.state, turns: { ...this.state.turns, [event.slug]: { ...held, state: 'failed' } } };
        break;
      }
      case 'connection':
        this.state = { ...this.state, connection: event.status };
        break;
    }
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(fn: (s: UiState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
