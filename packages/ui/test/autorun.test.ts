import { describe, it, expect } from 'vitest';
import type { AutoRun, TurnBudget } from '@agenthub/shared';
import { autoRunFromForm, autoRunLabel, budgetSentence, budgetText, formatInterval, intervalWords, scheduleSentence } from '../src/autorun.js';

describe('formatInterval', () => {
  it('shows minutes below an hour, and whole hours above it', () => {
    expect(formatInterval(15)).toBe('15m');
    expect(formatInterval(30)).toBe('30m');
    expect(formatInterval(60)).toBe('1h');
    expect(formatInterval(120)).toBe('2h');
    expect(formatInterval(240)).toBe('4h');
  });

  it('falls back to minutes for anything not a whole number of hours', () => {
    expect(formatInterval(90)).toBe('90m');
  });
});

describe('autoRunLabel', () => {
  it('reads off when there is nothing to run', () => {
    expect(autoRunLabel(undefined)).toBe('Auto-run: off');
    expect(autoRunLabel({ enabled: false, everyMinutes: 30, maxTurnsPerDay: 6 })).toBe('Auto-run: off');
  });

  it('reads the schedule when enabled', () => {
    const autoRun: AutoRun = { enabled: true, everyMinutes: 30, maxTurnsPerDay: 6 };
    expect(autoRunLabel(autoRun)).toBe('Auto-run: every 30m · 6/day');
  });
});

describe('budgetText', () => {
  it('is empty until a budget has arrived', () => {
    expect(budgetText(undefined)).toBe('');
  });

  it('names the project cap and the hub cap when the project has one', () => {
    const budget: TurnBudget = { usedToday: 2, maxPerDay: 6, hubUsedToday: 10, hubMaxPerDay: 40 };
    expect(budgetText(budget)).toBe('4/6 turns left today · hub 30/40');
  });

  it('names only the hub cap when the project has none', () => {
    const budget: TurnBudget = { usedToday: 2, maxPerDay: null, hubUsedToday: 10, hubMaxPerDay: 40 };
    expect(budgetText(budget)).toBe('hub 30/40 turns left today');
  });

  it('never goes negative once a cap is used past its limit', () => {
    const budget: TurnBudget = { usedToday: 9, maxPerDay: 6, hubUsedToday: 45, hubMaxPerDay: 40 };
    expect(budgetText(budget)).toBe('0/6 turns left today · hub 0/40');
  });
});

describe('autoRunFromForm', () => {
  it('accepts a valid interval and a 1..100 daily cap', () => {
    expect(autoRunFromForm({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 8 }))
      .toEqual({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 8 });
    expect(autoRunFromForm({ enabled: false, everyMinutes: '30', maxTurnsPerDay: '1' }))
      .toEqual({ enabled: false, everyMinutes: 30, maxTurnsPerDay: 1 });
  });

  it('rejects an interval outside AUTO_RUN_INTERVALS', () => {
    expect(autoRunFromForm({ enabled: true, everyMinutes: 45, maxTurnsPerDay: 6 })).toBeNull();
    expect(autoRunFromForm({ enabled: true, everyMinutes: 'nope', maxTurnsPerDay: 6 })).toBeNull();
  });

  it('rejects a daily cap outside 1..100 or non-integer', () => {
    expect(autoRunFromForm({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 0 })).toBeNull();
    expect(autoRunFromForm({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 101 })).toBeNull();
    expect(autoRunFromForm({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 4.5 })).toBeNull();
  });
});

describe('the schedule in words', () => {
  it('says the interval the way a sentence would', () => {
    expect(intervalWords(15)).toBe('15 minutes');
    expect(intervalWords(60)).toBe('hour');
    expect(intervalWords(120)).toBe('2 hours');
    expect(intervalWords(90)).toBe('90 minutes');
  });

  it('describes an off or absent schedule as running only on request', () => {
    expect(scheduleSentence(undefined)).toBe('Runs only when you start a turn');
    expect(scheduleSentence({ enabled: false, everyMinutes: 60, maxTurnsPerDay: 6 })).toBe('Runs only when you start a turn');
  });

  it('describes an on schedule with its cap, singular where it is one', () => {
    expect(scheduleSentence({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 6 }))
      .toBe('Runs on its own every hour, at most 6 turns a day');
    expect(scheduleSentence({ enabled: true, everyMinutes: 30, maxTurnsPerDay: 1 }))
      .toBe('Runs on its own every 30 minutes, at most 1 turn a day');
  });

  it('says the turns left today with both caps, never below zero', () => {
    expect(budgetSentence(undefined)).toBe('');
    expect(budgetSentence({ usedToday: 2, maxPerDay: 6, hubUsedToday: 10, hubMaxPerDay: 40 }))
      .toBe('4 of 6 turns left today · 30 of 40 left across the hub');
    expect(budgetSentence({ usedToday: 2, maxPerDay: null, hubUsedToday: 45, hubMaxPerDay: 40 }))
      .toBe('No cap for this project · 0 of 40 left across the hub');
  });
});
