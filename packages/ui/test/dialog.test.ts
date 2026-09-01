import { describe, it, expect } from 'vitest';
import { revealCount, revealedText } from '../src/panels/dialog.js';

describe('revealCount', () => {
  it('reveals nothing on the tick the box opens', () => {
    expect(revealCount(0)).toBe(0);
  });

  it('reveals two characters per tick', () => {
    expect(revealCount(1)).toBe(2);
    expect(revealCount(2)).toBe(4);
    expect(revealCount(9)).toBe(18);
  });

  it('never reveals a negative count', () => {
    expect(revealCount(-3)).toBe(0);
  });
});

describe('revealedText', () => {
  it('grows the visible prefix tick by tick', () => {
    expect(revealedText('SCOUT', 0)).toBe('');
    expect(revealedText('SCOUT', 1)).toBe('SC');
    expect(revealedText('SCOUT', 2)).toBe('SCOU');
  });

  it('is complete once the ticks cover the text, and stays complete', () => {
    expect(revealedText('SCOUT', 3)).toBe('SCOUT');
    expect(revealedText('SCOUT', 400)).toBe('SCOUT');
  });

  it('counts the newlines between lines as revealed characters', () => {
    expect(revealedText('AB\nCD', 2)).toBe('AB\nC');
  });
});
