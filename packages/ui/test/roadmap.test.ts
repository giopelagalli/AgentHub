import { describe, it, expect } from 'vitest';
import { roadmapEmptyState, roadmapRows, type Milestone, type RoadmapDoc } from '../src/roadmap.js';

function milestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
  return { id, title: id, summary: `${id} summary`, status: 'planned', ...overrides };
}

const doc: RoadmapDoc = {
  milestones: [milestone('m1'), milestone('m2', { status: 'in-progress' }), milestone('m3')],
  currentId: 'm2',
};

describe('roadmapRows', () => {
  it('numbers the milestones from one, in the order the hub gave them', () => {
    expect(roadmapRows(doc).map((r) => [r.id, r.order])).toEqual([['m1', 1], ['m2', 2], ['m3', 3]]);
  });

  it('marks exactly the current milestone', () => {
    expect(roadmapRows(doc).filter((r) => r.current).map((r) => r.id)).toEqual(['m2']);
  });

  it('marks nothing current when the hub names no milestone, or names a stale one', () => {
    expect(roadmapRows({ milestones: doc.milestones }).some((r) => r.current)).toBe(false);
    expect(roadmapRows({ milestones: doc.milestones, currentId: null }).some((r) => r.current)).toBe(false);
    expect(roadmapRows({ milestones: doc.milestones, currentId: 'gone' }).some((r) => r.current)).toBe(false);
  });

  it('disables the move buttons at the edges only', () => {
    const rows = roadmapRows(doc);
    expect(rows.map((r) => r.canMoveUp)).toEqual([false, true, true]);
    expect(rows.map((r) => r.canMoveDown)).toEqual([true, true, false]);
  });

  it('pins both buttons on a single milestone', () => {
    const [only] = roadmapRows({ milestones: [milestone('solo')] });
    expect([only.canMoveUp, only.canMoveDown]).toEqual([false, false]);
  });

  it('keeps the estimate when there is one and leaves it off when there is not', () => {
    const rows = roadmapRows({ milestones: [milestone('a', { estimate: '2 days' }), milestone('b')] });
    expect(rows[0].estimate).toBe('2 days');
    expect(rows[1].estimate).toBeUndefined();
  });

  it('falls back on a status the hub does not define, and on a blank title', () => {
    const rows = roadmapRows({
      milestones: [milestone('a', { status: 'shipped' as 'done', title: '  ' })],
    });
    expect(rows[0].status).toBe('planned');
    expect(rows[0].title).toBe('Untitled milestone');
  });

  it('has no rows for an empty or missing roadmap', () => {
    expect(roadmapRows({ milestones: [] })).toEqual([]);
    expect(roadmapRows(null)).toEqual([]);
  });
});

describe('roadmapEmptyState', () => {
  it('offers to generate once the PRD is drafted', () => {
    expect(roadmapEmptyState(true).action).toBe('generate');
  });

  it('points at the PRD tab instead, when there is no PRD yet to generate from', () => {
    expect(roadmapEmptyState(false).action).toBe('prd');
  });
});
