import { describe, it, expect } from 'vitest';
import { PRIORITY_RANK, comparePriority } from '../src/index.js';
import type { JobSpec } from '../src/index.js';

describe('shared types', () => {
  it('ranks priorities interactive < project < batch', () => {
    expect(PRIORITY_RANK.interactive).toBeLessThan(PRIORITY_RANK.project);
    expect(PRIORITY_RANK.project).toBeLessThan(PRIORITY_RANK.batch);
  });

  it('comparePriority sorts specs by rank ascending', () => {
    const a: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'batch', payload: {} };
    const b: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'interactive', payload: {} };
    expect([a, b].sort(comparePriority)[0]).toBe(b);
  });
});
