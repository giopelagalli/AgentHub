import { describe, it, expect } from 'vitest';
import { AVATARS } from '@agenthub/shared';
import { AVATAR_SIZE, avatarPalette, avatarRows, isAvatar } from '../src/avatars.js';

describe('avatar art', () => {
  it('draws one 16x16 grid per avatar id', () => {
    for (const id of AVATARS) {
      const rows = avatarRows(id);
      expect(rows).toHaveLength(AVATAR_SIZE);
      for (const row of rows) expect(row).toHaveLength(AVATAR_SIZE);
    }
  });

  it('paints only characters the palette knows, plus transparent', () => {
    for (const id of AVATARS) {
      const palette = avatarPalette(id);
      for (const char of new Set(avatarRows(id).join(''))) {
        expect(char === '.' || palette[char] !== undefined).toBe(true);
      }
    }
  });

  it('gives each robot its own silhouette and its own neon', () => {
    const grids = AVATARS.map((id) => avatarRows(id).join('\n'));
    expect(new Set(grids).size).toBe(AVATARS.length);
    const neon = AVATARS.map((id) => avatarPalette(id).a);
    expect(new Set(neon).size).toBe(AVATARS.length);
  });

  it('falls back to a drawable robot for an avatar the roster invented', () => {
    expect(isAvatar('robot-chartreuse')).toBe(false);
    expect(avatarRows('robot-chartreuse')).toEqual(avatarRows('robot-cyan'));
  });
});
