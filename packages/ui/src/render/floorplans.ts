import type { Tier } from '@agenthub/shared';
import type { FloorId, StaticFloorId } from '../floors.js';
import type { UiState } from '../store.js';

export const GRID_COLS = 20;
export const GRID_ROWS = 18;

export interface Furniture {
  sprite: string;
  x: number;
  y: number;
  anim?: string;
  /** Pins the frame instead of animating it — used by the stream gauges. */
  frame?: number;
}

export interface Hotspot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorPlan {
  tilemap: string[];
  legend: Record<string, string>;
  furniture: Furniture[];
  hotspots: Hotspot[];
}

// Tilemap alphabet, shared by every floor; the per-floor legend picks the tiles.
//   T ceiling shadow   W wall face   B wall face + baseboard
//   S side wall / partition          f primary ground   g alternate ground
const TOP = 'TTTTTTTTTTTTTTTTTTTT';
const WALL = 'WWWWWWWWWWWWWWWWWWWW';
const BASE = 'BBBBBBBBBBBBBBBBBBBB';
const OPEN = 'SffffffffffffffffffS';
// 1F: a carpet runner down from the elevator bay, then across to reception.
const RUNNER_DOWN = 'SfggfffffffffffffffS';
// Terminates against both side walls rather than stopping mid-floor.
const RUNNER_ACROSS = 'SggggggggggggggggggS';
// 3F: an L-shaped corner office in the top-right. The vertical run (P) is the
// same painted ramp as the horizontal run (B) so the two read as one wall; the
// doorway is a gap in the vertical run, not at the corner.
const OFFICE = 'SffffffffffPfffffffS';
const OFFICE_DOOR = OPEN;
const OFFICE_BOTTOM = 'SffffffffffBBBBBBBBS';

const PAINTED = { T: 'wallTop', W: 'wallFace', B: 'wallBase', S: 'wallSide' };
const STEEL = { T: 'wallTop', W: 'wallFaceDark', B: 'wallBaseDark', S: 'wallSideDark' };

// The elevator sits in the same wall bay on every floor so the tower reads as
// one shaft; Task 4 hangs the elevator panel off this hotspot.
const ELEVATOR_X = 32;
const ELEVATOR_Y = 16;
const elevator: Furniture = { sprite: 'elevator', x: ELEVATOR_X, y: ELEVATOR_Y };
const elevatorHotspot: Hotspot = { id: 'elevator', x: ELEVATOR_X, y: ELEVATOR_Y, w: 32, h: 32 };

/** Desk with a robot seated behind it and a monitor standing on the near edge. */
function workstation(x: number, y: number, anim: 'idle' | 'typing'): Furniture[] {
  return [
    { sprite: anim === 'typing' ? 'agentTyping' : 'agentIdle', x: x + 2, y: y - 12, anim },
    { sprite: 'desk', x, y },
    { sprite: 'monitor', x: x + 18, y: y - 8, anim: 'flicker' },
  ];
}

// Centred in the 16..304 floor span: 56px of deck either side of the block.
const RACK_XS = [72, 104, 136, 168, 200, 232];
const SUBAGENT_XS = [32, 104, 176, 248];
const DESK_XS = [40, 144, 248];

const RACK_W = 16;
const RACK_H = 32;
const DESK_W = 32;
/** A workstation reads from the robot's head down to the desk's front edge. */
const STATION_H = 24;
const STATION_LIFT = 12;

/** Aisle slots on B1 and desk slots on 2F: front row first, then the back row. */
const RACK_SLOTS = [64, 144].flatMap((y) => RACK_XS.map((x) => ({ x, y })));
const DESK_SLOTS = [112, 200].flatMap((y) => DESK_XS.map((x) => ({ x, y })));

const GAUGE_TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];
const GAUGE_X = 160;
const GAUGE_PITCH = 32;
const GAUGE_Y = 24;
const GAUGE_SEGMENTS = 4;

export const FLOORPLANS: Record<StaticFloorId, FloorPlan> = {
  // B1 — dark steel plant room, two aisles of racks and an ops console.
  b1: {
    tilemap: [
      TOP,
      WALL,
      BASE,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
    ],
    legend: { ...STEEL, f: 'floorGrid' },
    // Racks and gauges are live data — see dynamicFurniture().
    furniture: [
      elevator,
      { sprite: 'desk', x: 144, y: 224 },
      { sprite: 'monitor', x: 162, y: 216, anim: 'flicker' },
    ],
    hotspots: [elevatorHotspot],
  },

  // 1F — warm chequerboard lobby: reception, job kiosk, floor directory.
  f1: {
    tilemap: [
      TOP,
      WALL,
      BASE,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_DOWN,
      RUNNER_ACROSS,
      RUNNER_ACROSS,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
    ],
    legend: { ...PAINTED, f: 'floorCream', g: 'floorPale' },
    furniture: [
      elevator,
      { sprite: 'directoryBoard', x: 240, y: 18 },
      { sprite: 'reception', x: 136, y: 136 },
      { sprite: 'plant', x: 112, y: 138 },
      { sprite: 'plant', x: 192, y: 138 },
      { sprite: 'kiosk', x: 72, y: 200 },
      { sprite: 'plant', x: 272, y: 208 },
    ],
    hotspots: [
      elevatorHotspot,
      { id: 'jobboard', x: 68, y: 196, w: 24, h: 28 },
      { id: 'directory', x: 238, y: 16, w: 28, h: 22 },
      { id: 'reception', x: 136, y: 136, w: 48, h: 14 },
    ],
  },

  // 2F — open-plan carpet; the workstations are one live agent each.
  f2: {
    tilemap: [
      TOP,
      WALL,
      BASE,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
    ],
    legend: { ...PAINTED, f: 'carpet' },
    furniture: [
      elevator,
      { sprite: 'plant', x: 24, y: 248 },
      { sprite: 'plant', x: 284, y: 248 },
    ],
    hotspots: [elevatorHotspot],
  },

  // PH — polished stone, gilded desk, briefing board, night skyline window.
  ph: {
    tilemap: [
      TOP,
      WALL,
      BASE,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
    ],
    legend: { ...PAINTED, f: 'carpetFancy' },
    furniture: [
      elevator,
      { sprite: 'windowPaneL', x: 176, y: 16 },
      { sprite: 'windowPaneC', x: 208, y: 16 },
      { sprite: 'windowPaneR', x: 240, y: 16 },
      // x/8 of these four lands on 23, 27, 31, 32 — one per twinkle phase.
      { sprite: 'twinkle', x: 188, y: 22, anim: 'twinkle' },
      { sprite: 'twinkle', x: 216, y: 20, anim: 'twinkle' },
      { sprite: 'twinkle', x: 250, y: 19, anim: 'twinkle' },
      { sprite: 'twinkle', x: 262, y: 23, anim: 'twinkle' },
      { sprite: 'briefingBoard', x: 96, y: 18 },
      // Executive desk set under the skyline.
      { sprite: 'plant', x: 176, y: 96 },
      { sprite: 'agentIdle', x: 216, y: 100, anim: 'idle' },
      { sprite: 'execDesk', x: 200, y: 112 },
      { sprite: 'monitor', x: 232, y: 104, anim: 'flicker' },
      { sprite: 'plant', x: 272, y: 176 },
      // Lounge: rug first, then what stands on it.
      { sprite: 'rug', x: 48, y: 200 },
      { sprite: 'armchair', x: 52, y: 194 },
      { sprite: 'armchair', x: 88, y: 194 },
      { sprite: 'coffeeTable', x: 66, y: 218 },
      { sprite: 'floorLamp', x: 120, y: 184 },
      { sprite: 'plant', x: 232, y: 240 },
    ],
    hotspots: [elevatorHotspot, { id: 'briefing', x: 96, y: 18, w: 32, h: 20 }],
  },
};

// A project floor reuses the former 3F sample layout verbatim: corner
// office, up to four subagent cubicles, wall task board.
const PROJECT_STATIONS = 4;

/**
 * A furnished project floor for `slug`: orchestrator office, task board, and
 * subagent cubicles. `state` isn't read today — `HubState.projects` carries
 * only the manifest (no per-project task/session count), so the station
 * count is pinned at the full `PROJECT_STATIONS`; once a live count is on the
 * wire this is the one place to plug in `min(PROJECT_STATIONS, count)`.
 */
export function projectFloorPlan(slug: string, _state: UiState): FloorPlan {
  return {
    tilemap: [
      TOP,
      WALL,
      BASE,
      OFFICE,
      OFFICE,
      OFFICE_DOOR,
      OFFICE,
      OFFICE_BOTTOM,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
      OPEN,
    ],
    legend: { ...PAINTED, P: 'partitionSide', f: 'carpet' },
    furniture: [
      elevator,
      { sprite: 'taskboard', x: 96, y: 20 },
      { sprite: 'directoryBoard', x: 144, y: 20 },
      { sprite: 'agentTyping', x: 224, y: 76, anim: 'typing' },
      { sprite: 'execDesk', x: 208, y: 88 },
      { sprite: 'monitor', x: 244, y: 80, anim: 'flicker' },
      { sprite: 'plant', x: 284, y: 56 },
      ...SUBAGENT_XS.slice(0, PROJECT_STATIONS).flatMap((x) => workstation(x, 176, 'typing')),
      { sprite: 'plant', x: 24, y: 248 },
      { sprite: 'plant', x: 284, y: 248 },
    ],
    hotspots: [
      elevatorHotspot,
      { id: `project:board:${slug}`, x: 96, y: 20, w: 32, h: 18 },
      { id: `project:sign:${slug}`, x: 144, y: 20, w: 24, h: 18 },
      { id: `project:orch:${slug}`, x: 208, y: 76, w: 48, h: 32 },
    ],
  };
}

function isProjectFloor(id: FloorId): id is `p:${string}` {
  return id.startsWith('p:');
}

/** Resolves any floor id to its plan — static lookup, or a generated project floor. */
export function planFor(floorId: FloorId, state: UiState): FloorPlan {
  if (isProjectFloor(floorId)) return projectFloorPlan(floorId.slice(2), state);
  return FLOORPLANS[floorId];
}

/**
 * The live half of a floor: one rack per registered node and the tier gauges on
 * B1, one staffed workstation per API agent on 2F. Nothing is baked into
 * FLOORPLANS, so the plans stay static data and this stays a pure projection of
 * the store. Nodes and agents beyond the floor's slots are not drawn.
 */
export function dynamicFurniture(floorId: FloorId, state: UiState): Furniture[] {
  const hub = state.hub;
  if (!hub) return [];

  if (floorId === 'b1') {
    return [
      ...hub.nodes.slice(0, RACK_SLOTS.length).map((node, i): Furniture => {
        const online = node.status === 'online';
        return {
          sprite: online ? 'rack' : 'rackOffline',
          x: RACK_SLOTS[i].x,
          y: RACK_SLOTS[i].y,
          anim: online ? 'led' : undefined,
        };
      }),
      ...GAUGE_TIERS.map((tier, i): Furniture => ({
        sprite: 'gauge',
        x: GAUGE_X + i * GAUGE_PITCH,
        y: GAUGE_Y,
        frame: Math.min(hub.streams[tier] ?? 0, GAUGE_SEGMENTS),
      })),
    ];
  }

  if (floorId === 'f2') {
    return hub.agents
      .slice(0, DESK_SLOTS.length)
      .flatMap((agent, i) =>
        workstation(DESK_SLOTS[i].x, DESK_SLOTS[i].y, state.busy.has(agent.id) ? 'typing' : 'idle'),
      );
  }

  return [];
}

/** Static hotspots plus the ones the live floors grow; used for hit-testing. */
export function hotspotsFor(floorId: FloorId, state: UiState): Hotspot[] {
  const plan = planFor(floorId, state);
  const hub = state.hub;
  if (!hub) return plan.hotspots;

  if (floorId === 'b1') {
    return [
      ...plan.hotspots,
      ...hub.nodes.slice(0, RACK_SLOTS.length).map(
        (node, i): Hotspot => ({
          id: `rack:${node.name}`,
          x: RACK_SLOTS[i].x,
          y: RACK_SLOTS[i].y,
          w: RACK_W,
          h: RACK_H,
        }),
      ),
    ];
  }

  if (floorId === 'f2') {
    return [
      ...plan.hotspots,
      ...hub.agents.slice(0, DESK_SLOTS.length).map(
        (agent, i): Hotspot => ({
          id: `agent:${agent.id}`,
          x: DESK_SLOTS[i].x,
          y: DESK_SLOTS[i].y - STATION_LIFT,
          w: DESK_W,
          h: STATION_H,
        }),
      ),
    ];
  }

  return plan.hotspots;
}
