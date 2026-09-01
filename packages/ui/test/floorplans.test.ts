import { describe, it, expect } from 'vitest';
import { FLOORS } from '../src/floors.js';
import { TILES, TILE_SIZE } from '../src/art/tiles.js';
import { SPRITES } from '../src/art/sprites.js';
import { FLOORPLANS, GRID_COLS, GRID_ROWS } from '../src/render/floorplans.js';

const SCREEN_W = GRID_COLS * TILE_SIZE;
const SCREEN_H = GRID_ROWS * TILE_SIZE;

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
