import { describe, it, expect } from 'vitest';
import { TILE_SIZE, TILES } from '../src/art/tiles.js';
import { SPRITES } from '../src/art/sprites.js';
import { validateSprite } from '../src/art/validate.js';

describe('TILES', () => {
  it('exports tiles', () => {
    expect(Object.keys(TILES).length).toBeGreaterThan(0);
  });

  for (const [name, def] of Object.entries(TILES)) {
    it(`${name} is a valid, fully opaque ${TILE_SIZE}x${TILE_SIZE} tile`, () => {
      expect(() => validateSprite(def)).not.toThrow();
      expect(def.rows).toHaveLength(TILE_SIZE);
      for (const row of def.rows) {
        expect(row).toHaveLength(TILE_SIZE);
        expect(row).not.toContain('.');
      }
    });
  }
});

describe('SPRITES', () => {
  it('exports sprites', () => {
    expect(Object.keys(SPRITES).length).toBeGreaterThan(0);
  });

  for (const [name, frames] of Object.entries(SPRITES)) {
    it(`${name} has valid frames of a single size`, () => {
      expect(frames.length).toBeGreaterThan(0);
      const height = frames[0].rows.length;
      const width = frames[0].rows[0].length;
      expect(height).toBeGreaterThan(0);
      expect(width).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(() => validateSprite(frame)).not.toThrow();
        expect(frame.rows).toHaveLength(height);
        for (const row of frame.rows) expect(row).toHaveLength(width);
      }
    });
  }
});
