import { describe, it, expect } from 'vitest';
import type { TeamRoster } from '@agenthub/shared';
import { orgChartModel } from '../src/org.js';

function roster(overrides: Partial<TeamRoster> = {}): TeamRoster {
  return {
    members: [
      { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', status: 'idle', sessionsCount: 0, createdAt: 0 },
      { id: 'reviewer-1', name: 'Bo', role: 'reviewer', avatar: 'robot-green', status: 'working', sessionsCount: 3, createdAt: 0 },
    ],
    manager: { status: 'idle' },
    ...overrides,
  };
}

describe('orgChartModel', () => {
  it('is four tiers: you, the two global agents, the manager, the employees', () => {
    const tiers = orgChartModel(roster());
    expect(tiers.map((t) => t.label)).toEqual(['Owner', 'Global', 'Project', 'Employees']);
    expect(tiers.map((t) => t.cards.map((c) => c.kind))).toEqual([
      ['owner'], ['assistant', 'master'], ['manager'], ['employee', 'employee'],
    ]);
  });

  it('chains who reports to whom', () => {
    const tiers = orgChartModel(roster());
    expect(tiers[0].cards[0].reportsTo).toBeNull();
    expect(tiers[1].cards.map((c) => c.reportsTo)).toEqual(['You', 'You']);
    expect(tiers[2].cards[0].reportsTo).toBe('Master');
    expect(tiers[3].cards.map((c) => c.reportsTo)).toEqual(['Manager', 'Manager']);
  });

  it('names the manager by its job and carries employee name, role and avatar', () => {
    const tiers = orgChartModel(roster());
    expect(tiers[2].cards[0].role).toBe('Project orchestrator');
    expect(tiers[3].cards[0]).toMatchObject({ id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan' });
  });

  it('takes working/idle from the roster', () => {
    const tiers = orgChartModel(roster());
    expect(tiers[2].cards[0].status).toBe('idle');
    expect(tiers[3].cards.map((c) => c.status)).toEqual(['idle', 'working']);
  });

  it('counts an agent mid-reply as working, whatever the roster last said', () => {
    const tiers = orgChartModel(roster(), new Set(['manager', 'coder-1']));
    expect(tiers[2].cards[0].status).toBe('working');
    expect(tiers[3].cards.map((c) => c.status)).toEqual(['working', 'working']);
  });

  it('still draws the hierarchy before the roster has loaded', () => {
    const tiers = orgChartModel(null);
    expect(tiers[2].cards[0].status).toBeNull();
    expect(tiers[3].cards).toEqual([]);
  });

  it('gives every card but the owner an avatar', () => {
    const cards = orgChartModel(roster()).flatMap((t) => t.cards);
    expect(cards.filter((c) => c.avatar === null).map((c) => c.kind)).toEqual(['owner']);
  });
});
