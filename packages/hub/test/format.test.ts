import { describe, it, expect } from 'vitest';
import type { NodeInfo } from '@agenthub/shared';
import type { Briefing } from '../src/projects/schema.js';
import { formatBriefing, formatNodes, formatPlanner, formatProjects, splitMessage } from '../src/telegram/format.js';

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    slug: 'demo', title: 'Demo', status: 'active', priority: 'project',
    summary: 'moving along', progress: { done: 1, total: 2 },
    blockers: [], nextSteps: [], updatedAt: 1000,
    ...overrides,
  };
}

describe('formatProjects', () => {
  it('reports no projects when there are no briefings', () => {
    expect(formatProjects([])).toEqual({ text: 'No projects have published a briefing yet.' });
  });

  it('lists one line per project with pause/turn buttons for an active project', () => {
    const msg = formatProjects([briefing()]);
    expect(msg.text).toContain('Demo (demo)');
    expect(msg.text).toContain('active');
    expect(msg.text).toContain('1/2');
    expect(msg.buttons).toEqual([[
      { text: 'Pause', data: 'proj:pause:demo' },
      { text: 'Run turn', data: 'proj:turn:demo' },
    ]]);
  });

  it('offers Resume instead of Pause for a paused project', () => {
    const msg = formatProjects([briefing({ status: 'paused' })]);
    expect(msg.buttons?.[0]?.[0]).toEqual({ text: 'Resume', data: 'proj:resume:demo' });
  });
});

describe('formatBriefing', () => {
  it('appends one line per project after the master text', () => {
    const msg = formatBriefing('Everything is on track.', [briefing()]);
    expect(msg.text).toContain('Everything is on track.');
    expect(msg.text).toContain('Demo: active, 1/2 done');
  });

  it('returns the text unchanged when there are no briefings', () => {
    expect(formatBriefing('No projects yet.', [])).toEqual({ text: 'No projects yet.' });
  });
});

describe('formatNodes', () => {
  const node = (overrides: Partial<NodeInfo> = {}): NodeInfo => ({
    id: 1, name: 'spark', arch: 'arm64', status: 'online', lastHeartbeat: 1000, owner: 'admin',
    endpoints: [{ tier: 'orchestrator', url: 'http://x', model: 'm', maxStreams: 4 }],
    jobTypes: ['llm-session'],
    ...overrides,
  });

  it('reports no nodes when the registry is empty', () => {
    expect(formatNodes([], {})).toEqual({ text: 'No nodes registered.' });
  });

  it('lists node status and tiers, and any active stream counts', () => {
    const msg = formatNodes([node()], { orchestrator: 2 });
    expect(msg.text).toContain('spark (arm64) — online, tiers: orchestrator');
    expect(msg.text).toContain('orchestrator: 2 active');
  });
});

describe('formatPlanner', () => {
  it('reports an empty list', () => {
    expect(formatPlanner('todo', [])).toEqual({ text: 'Todo: (empty)' });
  });

  it('marks done items with an x', () => {
    const msg = formatPlanner('goals', [
      { n: 1, text: 'ship phase 4', done: false },
      { n: 2, text: 'sleep', done: true },
    ]);
    expect(msg.text).toBe('Goals:\n1. [ ] ship phase 4\n2. [x] sleep');
  });
});

describe('splitMessage', () => {
  it('returns the text unchanged when under the limit', () => {
    expect(splitMessage('short', 10)).toEqual(['short']);
  });

  it('splits on paragraph boundaries once the text exceeds the limit', () => {
    const parts = splitMessage('one two three\n\nfour five six', 20);
    expect(parts).toEqual(['one two three', 'four five six']);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(20);
  });

  it('hard-splits a single paragraph longer than the limit', () => {
    const parts = splitMessage('a'.repeat(25), 10);
    expect(parts).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});
