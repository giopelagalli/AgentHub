import { describe, it, expect } from 'vitest';
import { FLOORS } from '../src/floors.js';

describe('FLOORS', () => {
  it('has the exact order, ids, and labels from the design spec', () => {
    expect(FLOORS).toEqual([
      { id: 'b1', label: 'B1 SERVER ROOM' },
      { id: 'f1', label: '1F LOBBY' },
      { id: 'f2', label: '2F GENERAL STAFF' },
      { id: 'f3', label: '3F SAMPLE PROJECT' },
      { id: 'f4', label: '4F VACANT' },
      { id: 'ph', label: 'PH PENTHOUSE' },
    ]);
  });
});
