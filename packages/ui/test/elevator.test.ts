import { describe, it, expect } from 'vitest';
import { DOOR_TICKS, Elevator, elevatorFrame, type ElevatorState } from '../src/elevator.js';
import { Store } from '../src/store.js';

function setup() {
  const store = new Store();
  const seen: ElevatorState[] = [];
  const elevator = new Elevator(store, (s) => seen.push(s));
  return { store, elevator, seen };
}

describe('Elevator', () => {
  it('starts idle and opens the menu', () => {
    const { elevator } = setup();
    expect(elevator.state).toEqual({ kind: 'idle' });
    elevator.open();
    expect(elevator.state).toEqual({ kind: 'menuOpen' });
  });

  it('cancels back to idle from the menu', () => {
    const { elevator, store } = setup();
    elevator.open();
    elevator.cancel();
    expect(elevator.state).toEqual({ kind: 'idle' });
    expect(store.getState().floor).toBe('f1');
  });

  it('runs the full close/swap/open cycle, changing floor at the boundary', () => {
    const { elevator, store } = setup();
    elevator.open();
    elevator.choose('b1');
    expect(elevator.state).toEqual({ kind: 'doorsClosing', target: 'b1', ticks: 0 });

    for (let i = 1; i < DOOR_TICKS; i++) {
      elevator.tick();
      expect(elevator.state).toEqual({ kind: 'doorsClosing', target: 'b1', ticks: i });
      expect(store.getState().floor).toBe('f1');
    }

    elevator.tick();
    expect(elevator.state).toEqual({ kind: 'doorsOpening', ticks: 0 });
    expect(store.getState().floor).toBe('b1');

    for (let i = 1; i < DOOR_TICKS; i++) {
      elevator.tick();
      expect(elevator.state).toEqual({ kind: 'doorsOpening', ticks: i });
    }

    elevator.tick();
    expect(elevator.state).toEqual({ kind: 'idle' });
    expect(store.getState().floor).toBe('b1');
  });

  it('just closes the menu when the current floor is chosen', () => {
    const { elevator, store } = setup();
    let floorChanges = 0;
    store.subscribe(() => floorChanges++);
    elevator.open();
    elevator.choose('f1');
    expect(elevator.state).toEqual({ kind: 'idle' });
    expect(floorChanges).toBe(0);
  });

  it('accepts a choice straight from idle (keyboard shortcut)', () => {
    const { elevator } = setup();
    elevator.choose('ph');
    expect(elevator.state).toEqual({ kind: 'doorsClosing', target: 'ph', ticks: 0 });
  });

  it('ignores input while the doors are moving', () => {
    const { elevator, store } = setup();
    elevator.choose('f4');
    elevator.open();
    elevator.choose('ph');
    elevator.cancel();
    expect(elevator.state).toEqual({ kind: 'doorsClosing', target: 'f4', ticks: 0 });
    for (let i = 0; i < DOOR_TICKS * 2; i++) elevator.tick();
    expect(store.getState().floor).toBe('f4');
    expect(elevator.state).toEqual({ kind: 'idle' });
  });

  it('does nothing on tick while idle or in the menu', () => {
    const { elevator, seen } = setup();
    elevator.tick();
    expect(elevator.state).toEqual({ kind: 'idle' });
    elevator.open();
    elevator.tick();
    expect(elevator.state).toEqual({ kind: 'menuOpen' });
    expect(seen).toEqual([{ kind: 'menuOpen' }]);
  });

  it('reports every state change to the listener', () => {
    const { elevator, seen } = setup();
    elevator.open();
    elevator.choose('f3');
    for (let i = 0; i < DOOR_TICKS * 2; i++) elevator.tick();
    expect(seen.map((s) => s.kind)).toEqual([
      'menuOpen',
      'doorsClosing',
      'doorsOpening',
      'idle',
    ]);
  });
});

describe('elevatorFrame', () => {
  const FRAMES = 4;

  it('rests on the open frame when nobody is riding', () => {
    expect(elevatorFrame('idle', 0, FRAMES)).toBe(FRAMES - 1);
    expect(elevatorFrame('menuOpen', 0, FRAMES)).toBe(FRAMES - 1);
  });

  it('runs open → shut while the doors close', () => {
    expect(elevatorFrame('doorsClosing', 0, FRAMES)).toBe(FRAMES - 1);
    expect(elevatorFrame('doorsClosing', DOOR_TICKS - 1, FRAMES)).toBe(0);
  });

  it('runs shut → open while the doors open', () => {
    expect(elevatorFrame('doorsOpening', 0, FRAMES)).toBe(0);
    expect(elevatorFrame('doorsOpening', DOOR_TICKS - 1, FRAMES)).toBe(FRAMES - 1);
  });

  it('never leaves the frame range', () => {
    for (let ticks = 0; ticks < DOOR_TICKS; ticks++) {
      for (const phase of ['doorsClosing', 'doorsOpening'] as const) {
        const frame = elevatorFrame(phase, ticks, FRAMES);
        expect(frame).toBeGreaterThanOrEqual(0);
        expect(frame).toBeLessThan(FRAMES);
      }
    }
  });
});
