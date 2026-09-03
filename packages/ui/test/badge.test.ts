import { describe, it, expect } from 'vitest';
import { badgeLabel } from '../src/badge.js';

describe('badgeLabel', () => {
  it('maps each connection status to its GB text', () => {
    expect(badgeLabel('live')).toBe('LIVE');
    expect(badgeLabel('polling')).toBe('POLLING');
    expect(badgeLabel('down')).toBe('OFFLINE');
  });
});
