import { describe, it, expect } from 'vitest';
import { headingId } from '../src/markdown.js';
import { auditStrip, sectionState, type PrdAudit } from '../src/prd.js';

const audit: PrdAudit = {
  score: 72,
  missing: ['Data model'],
  sections: [
    { key: 'overview', title: 'Overview & problem', present: true, thin: false },
    { key: 'goals', title: 'Goals & non-goals', present: true, thin: true },
    { key: 'data', title: 'Data model', present: false, thin: false },
  ],
};

describe('sectionState', () => {
  it('collapses the hub’s two booleans into one word', () => {
    expect(sectionState({ present: true, thin: false })).toBe('filled');
    expect(sectionState({ present: true, thin: true })).toBe('thin');
    expect(sectionState({ present: false, thin: false })).toBe('missing');
    // A section that is not there cannot also be thin; absence wins either way.
    expect(sectionState({ present: false, thin: true })).toBe('missing');
  });
});

describe('auditStrip', () => {
  it('gives each state its own class and says so in the hint', () => {
    const { chips } = auditStrip(audit);
    expect(chips.map((c) => c.className)).toEqual([
      'chip chip--filled', 'chip chip--thin', 'chip chip--missing',
    ]);
    expect(chips.map((c) => c.hint)).toEqual([
      'Overview & problem — covered', 'Goals & non-goals — thin', 'Data model — missing',
    ]);
  });

  it('labels each chip with the heading as the document spells it', () => {
    expect(auditStrip(audit).chips.map((c) => c.heading))
      .toEqual(['Overview & problem', 'Goals & non-goals', 'Data model']);
  });

  it('points each chip at the heading it grades, entities and all', () => {
    const { chips } = auditStrip(audit);
    expect(chips[0].targetId).toBe(headingId('Overview & problem'));
    expect(chips[0].targetId).toBe(headingId('Overview &amp; problem'));
    expect(chips[2].targetId).toBe('md-data-model');
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

  it('falls back to the section key when the hub sends no title', () => {
    const { chips } = auditStrip({
      score: 0, sections: [{ key: 'ux', title: '  ', present: true, thin: false }],
    });
    expect(chips[0].heading).toBe('ux');
  });
});
