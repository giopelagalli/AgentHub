import { describe, it, expect } from 'vitest';
import { overviewInvite, overviewNow, recentTurns, turnTone } from '../src/overview.js';
import type { Briefing } from '../src/panels/master.js';
import type { RoadmapDoc } from '../src/roadmap.js';
import type { TurnRecord } from '../src/turns.js';

const roadmap: RoadmapDoc = {
  milestones: [
    { id: 'm1', title: 'Skeleton', summary: '', status: 'done' },
    { id: 'm2', title: 'Timer', summary: '', status: 'in-progress' },
    { id: 'm3', title: 'Session log', summary: '', status: 'planned' },
  ],
  currentId: 'm2',
};

const briefing: Briefing = {
  slug: 'p', title: 'P', status: 'active', priority: 'project',
  summary: '  Timer works; notifications next.  ', progress: { done: 1, total: 3 },
  blockers: ['', 'Needs a decision on sounds'], nextSteps: ['  ', 'Wire the bell'], updatedAt: 0,
};

const turn = (overrides: Partial<TurnRecord>): TurnRecord => ({
  sessionId: 1, startedAt: 0, endedAt: 1, outcome: 'completed', summary: '', toolCalls: 0,
  cost: { usd: 0, tokens: 0 }, events: [], ...overrides,
});

describe('overviewNow', () => {
  it('names the current milestone, the progress and the briefing, trimmed', () => {
    expect(overviewNow(roadmap, briefing)).toEqual({
      milestone: 'Timer',
      milestoneCurrent: true,
      progress: { done: 1, total: 3 },
      briefing: 'Timer works; notifications next.',
      next: 'Wire the bell',
      blockers: ['Needs a decision on sounds'],
    });
  });

  it('falls back to the next planned milestone when none is current', () => {
    const idle: RoadmapDoc = { milestones: [roadmap.milestones[0], roadmap.milestones[2]], currentId: null };
    const now = overviewNow(idle, null);
    expect(now.milestone).toBe('Session log');
    expect(now.milestoneCurrent).toBe(false);
    expect(now.progress).toEqual({ done: 1, total: 2 });
  });

  it('has nothing to say without a roadmap or a briefing', () => {
    expect(overviewNow(null, null)).toEqual({
      milestone: null, milestoneCurrent: false, progress: null, briefing: null, next: null, blockers: [],
    });
  });
});

describe('overviewInvite', () => {
  it('waits while anything is still loading', () => {
    expect(overviewInvite(null, 0, 0)).toBeNull();
    expect(overviewInvite(true, null, 0)).toBeNull();
    expect(overviewInvite(true, 3, null)).toBeNull();
  });

  it('invites the next step in the order a project is built', () => {
    expect(overviewInvite(false, 0, 0)?.kind).toBe('prd');
    expect(overviewInvite(true, 0, 0)?.kind).toBe('roadmap');
    expect(overviewInvite(true, 3, 0)?.kind).toBe('turn');
    expect(overviewInvite(true, 3, 1)).toBeNull();
  });

  it('asks for the PRD first even when turns have already run', () => {
    expect(overviewInvite(false, 0, 4)?.action).toBe('Draft the PRD');
  });
});

describe('recentTurns and turnTone', () => {
  it('keeps the newest three', () => {
    const turns = [1, 2, 3, 4].map((id) => turn({ sessionId: id }));
    expect(recentTurns(turns).map((t) => t.sessionId)).toEqual([1, 2, 3]);
  });

  it('tells running, failed and fine apart', () => {
    expect(turnTone(turn({ endedAt: null, outcome: null }))).toBe('running');
    expect(turnTone(turn({ outcome: 'error: model unreachable' }))).toBe('failed');
    expect(turnTone(turn({ outcome: 'stop' }))).toBe('ok');
  });
});
