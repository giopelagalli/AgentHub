import type { HubState } from '@agenthub/shared';
import type { UiState } from './store.js';

/** The floors that always exist, independent of live hub state. */
export type StaticFloorId = 'b1' | 'f1' | 'f2' | 'f5' | 'ph';

/** A project floor's id carries its slug, e.g. `p:acme-portal`. */
export type FloorId = StaticFloorId | `p:${string}`;

export interface FloorDef {
  id: FloorId;
  label: string;
}

export const FLOORS: { id: StaticFloorId; label: string }[] = [
  { id: 'b1', label: 'B1 SERVER ROOM' },
  { id: 'f1', label: '1F LOBBY' },
  { id: 'f2', label: '2F GENERAL STAFF' },
  { id: 'f5', label: '5F SCREENING ROOM' },
  { id: 'ph', label: 'PH PENTHOUSE' },
];

const [B1, F1, F2, F5, PH] = FLOORS;

const TITLE_MAX = 14;

function projectLabel(n: number, title: string): string {
  const upper = title.toUpperCase();
  const truncated = upper.length > TITLE_MAX ? `${upper.slice(0, TITLE_MAX)}…` : upper;
  return `${n}F ${truncated}`;
}

/**
 * The elevator's live floor list: the static basement/lobby/staff floors,
 * then one floor per project that hasn't finished, in the order the hub
 * reports them, then the screening room and the penthouse. Floor numbering for
 * projects starts at 3F — the first slot after the two static staff floors.
 */
export function floorsFor(state: UiState | { hub: HubState | null }): FloorDef[] {
  const projects = (state.hub?.projects ?? []).filter((p) => p.status !== 'done');
  const projectFloors: FloorDef[] = projects.map((p, i) => ({
    id: `p:${p.slug}`,
    label: projectLabel(i + 3, p.title),
  }));
  return [B1, F1, F2, ...projectFloors, F5, PH];
}
