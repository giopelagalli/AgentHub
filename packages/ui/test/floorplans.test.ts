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
  };
}

describe('FLOORPLANS', () => {
  it('covers exactly the floors in FLOORS', () => {
    expect(Object.keys(FLOORPLANS).sort()).toEqual(FLOORS.map((f) => f.id).sort());
  });

  it('fills the 320x288 canvas', () => {
    expect(SCREEN_W).toBe(320);
    expect(SCREEN_H).toBe(288);
  });

  for (const { id } of FLOORS) {
    describe(id, () => {
      const plan = FLOORPLANS[id];

      it(`has a rectangular ${GRID_COLS}x${GRID_ROWS} tilemap`, () => {
        expect(plan.tilemap).toHaveLength(GRID_ROWS);
        for (const row of plan.tilemap) expect(row).toHaveLength(GRID_COLS);
      });

      it('has a legend covering every tilemap char, mapping to real tiles', () => {
        const used = new Set(plan.tilemap.join('').split(''));
        for (const char of used) {
          expect(plan.legend, `legend missing '${char}'`).toHaveProperty(char);
          expect(TILES, `unknown tile '${plan.legend[char]}'`).toHaveProperty(plan.legend[char]);
        }
      });

      it('places furniture with known sprites, fully on screen', () => {
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
      });

      it('has unique hotspots inside the screen bounds, including the elevator', () => {
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
      });
    });
  }

  it('gives the lobby its jobboard and directory hotspots', () => {
    const ids = FLOORPLANS.f1.hotspots.map((h) => h.id);
    expect(ids).toContain('jobboard');
    expect(ids).toContain('directory');
  });

  it('gives the sample project floor sample: hotspots', () => {
    const ids = FLOORPLANS.f3.hotspots.map((h) => h.id);
    expect(ids).toContain('sample:orch');
    expect(ids.filter((id) => id.startsWith('sample:')).length).toBeGreaterThan(1);
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

  it('keeps every live sprite on screen', () => {
    for (const id of ['b1', 'f2'] as const) {
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
    expect(hotspotsFor('f3', live)).toBe(FLOORPLANS.f3.hotspots);
  });
});
