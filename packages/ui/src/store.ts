import type { HubState } from '@agenthub/shared';
import { floorsFor, type FloorId } from './floors.js';

/** One screencast frame off the `browser` topic; `jpegBase64` is decoded by the renderer. */
export interface BrowserFrame {
  nodeName: string;
  leaseId: string | null;
  jpegBase64: string;
  at: number;
}

export interface UiState {
  hub: HubState | null;
  busy: Set<number>;
  floor: FloorId;
  connection: 'live' | 'polling' | 'down';
  /** Newest screencast frame, or null when nothing has arrived for this visit to the screening room. */
  browserFrame: BrowserFrame | null;
}

export type StoreEvent =
  | { type: 'hub-state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean }
  | { type: 'busy-reset' }
  | { type: 'set-floor'; floor: FloorId }
  | { type: 'browser-frame'; frame: BrowserFrame }
  | { type: 'connection'; status: UiState['connection'] };

export class Store {
  private state: UiState = {
    hub: null, busy: new Set(), floor: 'f1', connection: 'down', browserFrame: null,
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
        // A project floor vanishes once its project is done (or gone); riding
        // it out from underneath the viewer would strand them, so drop back
        // to the lobby instead.
        const stillExists = floorsFor({ hub: event.state }).some((f) => f.id === this.state.floor);
        const floor = stillExists ? this.state.floor : 'f1';
        this.state = { ...this.state, hub: event.state, busy, floor };
        break;
      }
      case 'agent-busy': {
        const busy = new Set(this.state.busy);
        if (event.busy) busy.add(event.agentId);
        else busy.delete(event.agentId);
        this.state = { ...this.state, busy };
        break;
      }
      case 'busy-reset':
        this.state = { ...this.state, busy: new Set() };
        break;
      // Leaving the screening room drops the last frame: the cast stops with the
      // unsubscribe, and coming back to a frozen still would read as live.
      case 'set-floor':
        this.state = {
          ...this.state,
          floor: event.floor,
          browserFrame: event.floor === 'f5' ? this.state.browserFrame : null,
        };
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
