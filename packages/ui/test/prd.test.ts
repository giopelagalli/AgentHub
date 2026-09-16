import { describe, it, expect } from 'vitest';
import { headingId } from '../src/markdown.js';
import { auditStrip, type PrdAudit } from '../src/prd.js';

const audit: PrdAudit = {
  score: 72,
  sections: [
    { heading: 'Problem', state: 'filled' },
    { heading: 'Users', state: 'thin' },
    { heading: 'Non-goals', state: 'missing' },
  ],
};

describe('auditStrip', () => {
  it('gives each state its own class and says so in the hint', () => {
    const { chips } = auditStrip(audit);
    expect(chips.map((c) => c.className)).toEqual([
      'chip chip--filled', 'chip chip--thin', 'chip chip--missing',
    ]);
    expect(chips.map((c) => c.hint)).toEqual([
      'Problem — covered', 'Users — thin', 'Non-goals — missing',
    ]);
  });

  it('points each chip at the heading it grades', () => {
    const { chips } = auditStrip(audit);
    expect(chips[2].targetId).toBe(headingId('Non-goals'));
    expect(chips[0].targetId).toBe('md-problem');
  });

  it('treats "present" as filled, and anything unrecognised as missing', () => {
    const { chips } = auditStrip({
      score: 0,
      sections: [
        { heading: 'A', state: 'present' },
        { heading: 'B', state: 'unknown' as 'thin' },
      ],
    });
    expect(chips.map((c) => c.state)).toEqual(['filled', 'missing']);
  });

  it('labels the score as a percentage, clamped and rounded', () => {
    expect(auditStrip(audit).scoreLabel).toBe('72%');
    expect(auditStrip({ score: 71.6, sections: [] }).score).toBe(72);
    expect(auditStrip({ score: -5, sections: [] }).score).toBe(0);
    expect(auditStrip({ score: 180, sections: [] }).score).toBe(100);
  });

  it('survives a hub answer with no audit in it', () => {
    expect(auditStrip(undefined)).toEqual({ chips: [], score: 0, scoreLabel: '0%' });
    expect(auditStrip({ sections: [] } as unknown as PrdAudit).score).toBe(0);
  });

  it('names a section the hub left blank rather than drawing an empty chip', () => {
    const { chips } = auditStrip({ score: 0, sections: [{ heading: '  ', state: 'thin' }] });
    expect(chips[0].heading).toBe('Untitled section');
  });
});
