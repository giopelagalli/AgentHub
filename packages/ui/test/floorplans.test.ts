import { describe, it, expect } from 'vitest';
import type { HubState, NodeInfo } from '@agenthub/shared';
import { FLOORS } from '../src/floors.js';
import { TILES, TILE_SIZE } from '../src/art/tiles.js';
import { SPRITES } from '../src/art/sprites.js';
import {
  dynamicFurniture,
  FLOORPLANS,
  GRID_COLS,
  GRID_ROWS,
  hotspotsFor,
  planFor,
  projectFloorPlan,
  TV_SCREEN,
} from '../src/render/floorplans.js';
import type { UiState } from '../src/store.js';

const SCREEN_W = GRID_COLS * TILE_SIZE;
const SCREEN_H = GRID_ROWS * TILE_SIZE;

function node(name: string, status: NodeInfo['status']): NodeInfo {
  return { id: 1, name, arch: 'arm64', status, lastHeartbeat: 0, endpoints: [], jobTypes: [] };
}

function uiState(hub: Partial<HubState> | null, busy: number[] = []): UiState {
  return {
    hub: hub && { nodes: [], agents: [], jobs: [], streams: {}, ...hub },
    busy: new Set(busy),
    floor: 'f1',
    connection: 'live',
    browserFrame: null,
  };
}

/** Asserts a plan's tilemap, legend, furniture, and hotspots all satisfy the shared invariants. */
function expectValidPlan(plan: (typeof FLOORPLANS)['b1']): void {
  expect(plan.tilemap).toHaveLength(GRID_ROWS);
  for (const row of plan.tilemap) expect(row).toHaveLength(GRID_COLS);

  const used = new Set(plan.tilemap.join('').split(''));
  for (const char of used) {
    expect(plan.legend, `legend missing '${char}'`).toHaveProperty(char);
    expect(TILES, `unknown tile '${plan.legend[char]}'`).toHaveProperty(plan.legend[char]);
  }

  for (const item of plan.furniture) {
    const frames = SPRITES[item.sprite];
    expect(frames, `unknown sprite '${item.sprite}'`).toBeDefined();
    const width = frames[0].rows[0].length;
    const height = frames[0].rows.length;
    expect(item.x).toBeGreaterThanOrEqual(0);
    expect(item.y).toBeGreaterThanOrEqual(0);
    expect(item.x + width).toBeLessThanOrEqual(SCREEN_W);
    expect(item.y + height).toBeLessThanOrEqual(SCREEN_H);
  }

  const ids = plan.hotspots.map((h) => h.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain('elevator');
  for (const spot of plan.hotspots) {
    expect(spot.w).toBeGreaterThan(0);
    expect(spot.h).toBeGreaterThan(0);
    expect(spot.x).toBeGreaterThanOrEqual(0);
    expect(spot.y).toBeGreaterThanOrEqual(0);
    expect(spot.x + spot.w).toBeLessThanOrEqual(SCREEN_W);
    expect(spot.y + spot.h).toBeLessThanOrEqual(SCREEN_H);
  }
}

describe('FLOORPLANS', () => {
  it('covers exactly the static floors in FLOORS', () => {
    expect(Object.keys(FLOORPLANS).sort()).toEqual(FLOORS.map((f) => f.id).sort());
  });

  it('fills the 320x288 canvas', () => {
    expect(SCREEN_W).toBe(320);
    expect(SCREEN_H).toBe(288);
  });

  for (const { id } of FLOORS) {
    describe(id, () => {
      it('is a valid plan', () => {
        expectValidPlan(FLOORPLANS[id]);
      });
    });
  }

  it('gives the screening room a browser hotspot over its screen', () => {
    const spot = FLOORPLANS.f5.hotspots.find((h) => h.id === 'browser:tv');
    expect(spot).toBeDefined();
    // The live view is painted into the screen well, which must sit inside the hotspot.
    expect(TV_SCREEN.x).toBeGreaterThanOrEqual(spot!.x);
    expect(TV_SCREEN.y).toBeGreaterThanOrEqual(spot!.y);
    expect(TV_SCREEN.x + TV_SCREEN.w).toBeLessThanOrEqual(spot!.x + spot!.w);
    expect(TV_SCREEN.y + TV_SCREEN.h).toBeLessThanOrEqual(spot!.y + spot!.h);
  });

  it('sizes the screen well at the 128x72 the spec asks for', () => {
    expect(TV_SCREEN.w).toBe(128);
    expect(TV_SCREEN.h).toBe(72);
    expect(SPRITES.tvStatic[0].rows[0]).toHaveLength(TV_SCREEN.w);
    expect(SPRITES.tvStatic[0].rows).toHaveLength(TV_SCREEN.h);
  });

  it('gives the lobby its jobboard and directory hotspots', () => {
    const ids = FLOORPLANS.f1.hotspots.map((h) => h.id);
    expect(ids).toContain('jobboard');
    expect(ids).toContain('directory');
  });
});

describe('projectFloorPlan', () => {
  const state = uiState(null);

  it('is a valid plan, generated from the former 3F sample layout', () => {
    expectValidPlan(projectFloorPlan('acme', state));
  });

  it('scopes its hotspots to the given slug', () => {
    const ids = projectFloorPlan('acme', state).hotspots.map((h) => h.id);
    expect(ids).toEqual([
      'elevator',
      'project:board:acme',
      'project:sign:acme',
      'project:orch:acme',
    ]);
  });

  it('uses a different slug per floor without colliding hotspot ids', () => {
    const a = projectFloorPlan('acme', state).hotspots.map((h) => h.id);
    const b = projectFloorPlan('zeta', state).hotspots.map((h) => h.id);
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length - 1); // only 'elevator' is shared
  });
});

describe('planFor', () => {
  const state = uiState(null);

  it('resolves static floor ids to FLOORPLANS', () => {
    expect(planFor('b1', state)).toBe(FLOORPLANS.b1);
  });

  it('resolves p:<slug> floor ids to a generated project floor', () => {
    expect(planFor('p:acme', state).hotspots.map((h) => h.id)).toContain('project:board:acme');
  });
});

describe('live floors', () => {
  const live = uiState(
    {
      nodes: [node('dev-node', 'online'), node('old-node', 'offline')],
      agents: [
        { id: 4, name: 'master', tier: 'orchestrator', systemPrompt: '' },
        { id: 9, name: 'scout', tier: 'worker', systemPrompt: '' },
      ],
      streams: { orchestrator: 1, worker: 99 },
    },
    [9],
  );

  it('draws nothing extra before the first hub state arrives', () => {
    const empty = uiState(null);
    for (const { id } of FLOORS) {
      expect(dynamicFurniture(id, empty)).toEqual([]);
      expect(hotspotsFor(id, empty)).toBe(FLOORPLANS[id].hotspots);
    }
  });

  it('racks B1 by node status and pins a gauge frame per tier', () => {
    const items = dynamicFurniture('b1', live);
    expect(items.filter((i) => i.sprite === 'rack')).toHaveLength(1);
    expect(items.filter((i) => i.sprite === 'rackOffline')).toHaveLength(1);
    expect(items.find((i) => i.sprite === 'rack')?.anim).toBe('led');
    expect(items.find((i) => i.sprite === 'rackOffline')?.anim).toBeUndefined();

    const gauges = items.filter((i) => i.sprite === 'gauge');
    expect(gauges).toHaveLength(4);
    // orchestrator=1, worker clamped to the four segments, the rest unreported.
    expect(gauges.map((g) => g.frame)).toEqual([1, 4, 0, 0]);
  });

  it('staffs 2F with one desk per agent, typing only while busy', () => {
    const items = dynamicFurniture('f2', live);
    expect(items.filter((i) => i.sprite === 'agentIdle')).toHaveLength(1);
    expect(items.filter((i) => i.sprite === 'agentTyping')).toHaveLength(1);
    expect(items.filter((i) => i.sprite === 'desk')).toHaveLength(2);
  });

  it('lights the screening room plaque red only while the browser is held', () => {
    const free = dynamicFurniture('f5', live);
    expect(free).toEqual([{ sprite: 'leasePlaque', x: 248, y: 28, frame: 0 }]);

    const held = uiState({
      browser: {
        holder: { leaseId: 'l1', requester: { kind: 'subagent', id: '7' }, expiresAt: 0 },
        queue: [],
        node: 'macmini',
      },
    });
    expect(dynamicFurniture('f5', held)[0].frame).toBe(1);
  });

  it('keeps every live sprite on screen', () => {
    for (const id of ['b1', 'f2', 'f5'] as const) {
      for (const item of dynamicFurniture(id, live)) {
        const frames = SPRITES[item.sprite];
        expect(frames, `unknown sprite '${item.sprite}'`).toBeDefined();
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.x + frames[0].rows[0].length).toBeLessThanOrEqual(SCREEN_W);
        expect(item.y + frames[0].rows.length).toBeLessThanOrEqual(SCREEN_H);
      }
    }
  });

  it('merges live hotspots with the static ones', () => {
    const b1 = hotspotsFor('b1', live).map((h) => h.id);
    expect(b1).toEqual(['elevator', 'rack:dev-node', 'rack:old-node']);
    const f2 = hotspotsFor('f2', live).map((h) => h.id);
    expect(f2).toEqual(['elevator', 'agent:4', 'agent:9']);
  });

  it('resolves project floor hotspots by slug, unaffected by nodes/agents', () => {
    expect(hotspotsFor('p:acme', live).map((h) => h.id)).toEqual([
      'elevator',
      'project:board:acme',
      'project:sign:acme',
      'project:orch:acme',
    ]);
  });
});
