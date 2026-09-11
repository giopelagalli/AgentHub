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
  { id: 'b1', label: 'B1' },
  { id: 'f1', label: 'LOBBY' },
  { id: 'f2', label: 'STAFF' },
  { id: 'f5', label: 'SCREENING' },
  { id: 'ph', label: 'PH' },
];

const [B1, F1, F2, F5, PH] = FLOORS;

const TITLE_MAX = 12;

/** A tab is a strip, not a sign: the project's title, cut to fit one. */
function projectLabel(title: string): string {
  const upper = title.toUpperCase();
  return upper.length > TITLE_MAX ? `${upper.slice(0, TITLE_MAX).trimEnd()}…` : upper;
}

/**
 * The live floor list behind the tab bar: the static basement/lobby/staff
 * floors, then one floor per project that hasn't finished, in the order the
 * hub reports them, then the screening room and the penthouse.
 */
export function floorsFor(state: UiState | { hub: HubState | null }): FloorDef[] {
  const projects = (state.hub?.projects ?? []).filter((p) => p.status !== 'done');
  const projectFloors: FloorDef[] = projects.map((p) => ({
    id: `p:${p.slug}`,
    label: projectLabel(p.title),
  }));
  return [B1, F1, F2, ...projectFloors, F5, PH];
}
