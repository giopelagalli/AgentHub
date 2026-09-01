import { describe, it, expect } from 'vitest';
import { PALETTE } from '../src/art/palette.js';

const REQUIRED: Record<string, string> = {
  bg0: '#0f140f',
  bg1: '#1a231a',
  ink: '#202820',
  mid: '#4a5d4a',
  lit: '#8fae7a',
  pale: '#cfe0b8',
  cream: '#e8e4c8',
  accentRed: '#b4433a',
  accentBlue: '#3a6ab4',
  accentAmber: '#c9a13b',
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
