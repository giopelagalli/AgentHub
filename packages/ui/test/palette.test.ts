import { describe, it, expect } from 'vitest';
import { PALETTE } from '../src/art/palette.js';

const REQUIRED: Record<string, string> = {
  bg0: '#07060f',
  bg1: '#120b22',
  ink: '#1a1030',
  mid: '#2c1a4d',
  lit: '#46306f',
  pale: '#7c8ac0',
  cream: '#aebbe6',
  accentRed: '#ff2d95',
  accentBlue: '#22e0ff',
  accentAmber: '#ffb43c',
};

describe('PALETTE', () => {
  it('contains all 10 required named entries with exact hex values', () => {
    for (const [name, hex] of Object.entries(REQUIRED)) {
      expect(PALETTE[name]).toBe(hex);
    }
  });

  it('every value is a #rrggbb hex string', () => {
    for (const [name, value] of Object.entries(PALETTE)) {
      expect(value, `PALETTE.${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
