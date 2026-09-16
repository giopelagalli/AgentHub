import { describe, it, expect } from 'vitest';
import { SLUG_PATTERN, deriveSlug, intentFrom, slugProblem } from '../src/newproject.js';

describe('deriveSlug', () => {
  it('lowercases and dashes a title', () => {
    expect(deriveSlug('Acme Portal')).toBe('acme-portal');
    expect(deriveSlug('Q4 — Billing Rework!')).toBe('q4-billing-rework');
  });

  it('collapses runs and trims the ends', () => {
    expect(deriveSlug('  ***Hello***  World  ')).toBe('hello-world');
    expect(deriveSlug('-leading and trailing-')).toBe('leading-and-trailing');
  });

  it('keeps digits, including a leading one', () => {
    expect(deriveSlug('2026 planning')).toBe('2026-planning');
  });

  it('comes back empty when there is nothing to slug', () => {
    expect(deriveSlug('???')).toBe('');
    expect(deriveSlug('')).toBe('');
  });

  it('never produces something the hub would reject', () => {
    const long = deriveSlug('a'.repeat(200));
    expect(long.length).toBe(63);
    expect(SLUG_PATTERN.test(long)).toBe(true);
    // Truncation must not leave the slug ending on a dash.
    expect(deriveSlug(`${'a'.repeat(62)} tail`)).toBe('a'.repeat(62));
  });
});

describe('slugProblem', () => {
  it('accepts what the hub accepts', () => {
    for (const slug of ['ab', 'acme-portal', 'a1', '2026-planning', `${'a'.repeat(63)}`]) {
      expect(slugProblem(slug), slug).toBeNull();
    }
  });

  it('rejects an empty, too-short or too-long slug', () => {
    expect(slugProblem('')).toBe('A slug is required.');
    expect(slugProblem('a')).toBe('At least 2 characters.');
    expect(slugProblem('a'.repeat(64))).toBe('At most 63 characters.');
  });

  it('rejects uppercase, spaces, underscores and a leading dash', () => {
    for (const slug of ['Acme', 'acme portal', 'acme_portal', '-acme', 'acme.portal']) {
      expect(slugProblem(slug), slug).not.toBeNull();
    }
  });
});

describe('intentFrom', () => {
  it('takes the opening of an idea, on one line', () => {
    expect(intentFrom('idea', '  A portal\n  for invoices.  ')).toBe('A portal for invoices.');
  });

  it('caps the idea at 200 characters', () => {
    expect(intentFrom('idea', 'x'.repeat(500))).toHaveLength(200);
  });

  it('takes a pasted PRD’s first heading, whatever depth it is', () => {
    expect(intentFrom('prd', 'preamble\n\n## Billing rework\n\nbody')).toBe('Billing rework');
    expect(intentFrom('prd', '# Acme Portal\n## Later heading')).toBe('Acme Portal');
  });

  it('falls back to the opening text when a PRD has no heading', () => {
    expect(intentFrom('prd', 'just a wall\nof text')).toBe('just a wall of text');
  });

  it('has nothing to say about empty input', () => {
    expect(intentFrom('idea', '   ')).toBe('');
    expect(intentFrom('prd', '')).toBe('');
  });
});
