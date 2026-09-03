import type { HubState } from '@agenthub/shared';
import type { FloorId } from './floors.js';

export interface UiState {
  hub: HubState | null;
  busy: Set<number>;
  floor: FloorId;
  connection: 'live' | 'polling' | 'down';
}

export type StoreEvent =
  | { type: 'hub-state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean }
  | { type: 'busy-reset' }
  | { type: 'set-floor'; floor: FloorId }
  | { type: 'connection'; status: UiState['connection'] };

export class Store {
  private state: UiState = { hub: null, busy: new Set(), floor: 'f1', connection: 'down' };
  private listeners = new Set<(s: UiState) => void>();

  getState(): UiState {
    return this.state;
  }

  dispatch(event: StoreEvent): void {
    switch (event.type) {
      case 'hub-state': {
        const agentIds = new Set(event.state.agents.map((a) => a.id));
        const busy = new Set([...this.state.busy].filter((id) => agentIds.has(id)));
        this.state = { ...this.state, hub: event.state, busy };
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
      case 'set-floor':
        this.state = { ...this.state, floor: event.floor };
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
