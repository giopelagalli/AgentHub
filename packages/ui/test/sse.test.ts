import { describe, it, expect } from 'vitest';
import { parseSseFrames } from '../src/sse.js';

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

describe('parseSseFrames', () => {
  it('parses a token/done sequence in one buffer', () => {
    const buf = frame({ token: 'Hel' }) + frame({ token: 'lo' }) + frame({ done: true, full: 'Hello' });
    const { events, rest } = parseSseFrames(buf);
    expect(events).toEqual([{ token: 'Hel' }, { token: 'lo' }, { done: true, full: 'Hello' }]);
    expect(rest).toBe('');
  });

  it('parses an error frame', () => {
    const { events } = parseSseFrames(frame({ error: 'Error: no capacity' }));
    expect(events).toEqual([{ error: 'Error: no capacity' }]);
  });

  it('holds a partial frame back in rest until the rest of it arrives', () => {
    const whole = frame({ token: 'abc' });
    const cut = whole.length - 3;

    const first = parseSseFrames(whole.slice(0, cut));
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(whole.slice(0, cut));

    const second = parseSseFrames(first.rest + whole.slice(cut) + 'data: {"token":');
    expect(second.events).toEqual([{ token: 'abc' }]);
    expect(second.rest).toBe('data: {"token":');
  });

  it('reassembles a stream fed one character at a time', () => {
    const stream = frame({ token: 'a' }) + frame({ token: 'b' }) + frame({ done: true, full: 'ab' });
    let rest = '';
    const events = [];
    for (const char of stream) {
      const parsed = parseSseFrames(rest + char);
      events.push(...parsed.events);
      rest = parsed.rest;
    }
    expect(events).toEqual([{ token: 'a' }, { token: 'b' }, { done: true, full: 'ab' }]);
    expect(rest).toBe('');
  });

  it('skips frames that are not data lines and frames whose payload is not JSON', () => {
    const buf = ': keep-alive\n\n' + 'data: not-json\n\n' + frame({ token: 'x' });
    const { events, rest } = parseSseFrames(buf);
    expect(events).toEqual([{ token: 'x' }]);
    expect(rest).toBe('');
  });

  it('returns nothing for an empty buffer', () => {
    expect(parseSseFrames('')).toEqual({ events: [], rest: '' });
  });
});
