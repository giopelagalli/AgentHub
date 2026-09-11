import type { HubState } from '@agenthub/shared';
import type { PageId } from './nav.js';

/** One screencast frame off the `browser` topic; `jpegBase64` is decoded by the page. */
export interface BrowserFrame {
  nodeName: string;
  leaseId: string | null;
  jpegBase64: string;
  at: number;
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
  /** Slug selected on the projects page; null when the hub has no project to show. */
  project: string | null;
  connection: 'live' | 'polling' | 'down';
  /** Newest screencast frame, or null when nothing has arrived for this visit to the computer page. */
  browserFrame: BrowserFrame | null;
}

export type StoreEvent =
  | { type: 'hub-state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean }
  | { type: 'project-busy'; slug: string; who: string; busy: boolean }
  | { type: 'busy-reset' }
  | { type: 'set-page'; page: PageId }
  | { type: 'set-project'; slug: string }
  | { type: 'browser-frame'; frame: BrowserFrame }
  | { type: 'connection'; status: UiState['connection'] };

export class Store {
  private state: UiState = {
    hub: null,
    busy: new Set(),
    projectBusy: new Set(),
    page: 'projects',
    project: null,
    connection: 'down',
    browserFrame: null,
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
      // Leaving the computer page drops the last frame: the cast stops with the
      // unsubscribe, and coming back to a frozen still would read as live.
      case 'set-page':
        this.state = {
          ...this.state,
          page: event.page,
          browserFrame: event.page === 'computer' ? this.state.browserFrame : null,
        };
        break;
      case 'set-project':
        this.state = { ...this.state, project: event.slug };
        break;
      case 'browser-frame':
        this.state = { ...this.state, browserFrame: event.frame };
        break;
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
