import type { FloorId } from './floors.js';
import type { Store } from './store.js';

/** Ticks (at 8/s) the doors spend closing, and again opening. */
export const DOOR_TICKS = 6;

/**
 * Door sprite frame for the current phase. The sprite's frames run shut → open,
 * so the closing phase plays them in reverse and the opening phase forwards;
 * every other phase rests on the last frame, doors open (a waiting car).
 */
export function elevatorFrame(phase: ElevatorState['kind'], ticks: number, frameCount: number): number {
  const last = frameCount - 1;
  // A waiting elevator stands open, so close → swap → open never pops.
  if (phase !== 'doorsClosing' && phase !== 'doorsOpening') return last;
  const step = Math.min(Math.floor((ticks * frameCount) / DOOR_TICKS), last);
  return phase === 'doorsOpening' ? step : last - step;
}

export type ElevatorState =
  | { kind: 'idle' }
  | { kind: 'menuOpen' }
  | { kind: 'doorsClosing'; target: FloorId; ticks: number }
  | { kind: 'doorsOpening'; ticks: number };

/**
 * Floor navigation as a state machine: `idle → menuOpen → doorsClosing →
 * doorsOpening → idle`. The store's floor changes exactly once per ride, at
 * the closing/opening boundary, so the swap is hidden behind shut doors.
 *
 * `onChange` fires on phase changes only, not on every tick of a timed phase —
 * it drives the DOM menu, while the renderer reads `state.ticks` per frame.
 */
export class Elevator {
  private current: ElevatorState = { kind: 'idle' };

  constructor(
    private readonly store: Store,
    private readonly onChange: (state: ElevatorState) => void = () => {},
  ) {}

  get state(): ElevatorState {
    return this.current;
  }

  open(): void {
    if (this.current.kind !== 'idle') return;
    this.enter({ kind: 'menuOpen' });
  }

  cancel(): void {
    if (this.current.kind !== 'menuOpen') return;
    this.enter({ kind: 'idle' });
  }

  /** From `menuOpen` (a menu pick) or `idle` (a keyboard shortcut). */
  choose(floor: FloorId): void {
    if (this.current.kind !== 'menuOpen' && this.current.kind !== 'idle') return;
    if (floor === this.store.getState().floor) {
      if (this.current.kind === 'menuOpen') this.enter({ kind: 'idle' });
      return;
    }
    this.enter({ kind: 'doorsClosing', target: floor, ticks: 0 });
  }

  tick(): void {
    const state = this.current;
    if (state.kind === 'doorsClosing') {
      if (state.ticks + 1 < DOOR_TICKS) {
        this.current = { ...state, ticks: state.ticks + 1 };
        return;
      }
      this.store.dispatch({ type: 'set-floor', floor: state.target });
      this.enter({ kind: 'doorsOpening', ticks: 0 });
      return;
    }
    if (state.kind === 'doorsOpening') {
      if (state.ticks + 1 < DOOR_TICKS) {
        this.current = { ...state, ticks: state.ticks + 1 };
        return;
      }
      this.enter({ kind: 'idle' });
    }
  }

  private enter(state: ElevatorState): void {
    this.current = state;
    this.onChange(state);
  }
}
