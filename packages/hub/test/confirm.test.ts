import { describe, it, expect } from 'vitest';
import { ConfirmationGate } from '../src/assistant/confirm.js';

const THIRTY_MIN = 30 * 60_000;

describe('ConfirmationGate', () => {
  it('holds a proposed action until it is confirmed', async () => {
    const gate = new ConfirmationGate();
    const action = gate.propose('post "hello" to X', async () => 'posted');

    expect(gate.pending()).toEqual([action]);
    expect(await gate.confirm(action.id)).toBe('posted');
    expect(gate.pending()).toEqual([]);
  });

  it('runs the action only once', async () => {
    const gate = new ConfirmationGate();
    let runs = 0;
    const action = gate.propose('demo', async () => `run ${++runs}`);

    await gate.confirm(action.id);
    await expect(gate.confirm(action.id)).rejects.toThrow(action.id);
    expect(runs).toBe(1);
  });

  it('never runs a cancelled action', async () => {
    const gate = new ConfirmationGate();
    let ran = false;
    const action = gate.propose('demo', async () => { ran = true; return 'done'; });

    expect(gate.cancel(action.id)).toBe(true);
    expect(gate.cancel(action.id)).toBe(false);
    expect(gate.pending()).toEqual([]);
    await expect(gate.confirm(action.id)).rejects.toThrow(action.id);
    expect(ran).toBe(false);
  });

  it('expires an action 30 minutes after it was proposed', async () => {
    let now = 1_000_000;
    const gate = new ConfirmationGate({ now: () => now });
    const action = gate.propose('demo', async () => 'done');

    now += THIRTY_MIN - 1;
    expect(gate.pending()).toHaveLength(1);

    now += 1;
    expect(gate.pending()).toEqual([]);
    await expect(gate.confirm(action.id)).rejects.toThrow(action.id);
  });
});
