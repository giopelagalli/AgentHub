import { describe, it, expect } from 'vitest';
import { PRIORITY_RANK, type HubState, type Priority, type ProjectManifest, type ProjectStatus, type TeamRoster } from '@agenthub/shared';
import type { UiState } from '../src/store.js';
import { orgChartModel } from '../src/org.js';
import { allocationRows } from '../src/pages/allocation.js';
import { managerCard, priorityLabel, projectsSignature } from '../src/pages/projects.js';

function project(slug: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schema: 1,
    slug,
    title: slug,
    status: 'active' as ProjectStatus,
    priority: 'project' as Priority,
    intent: '',
    links: [],
    createdAt: 0,
    updatedAt: 0,
    index: [],
    ...overrides,
  };
}

describe('allocationRows', () => {
  it('orders by priority, then most recently updated', () => {
    const rows = allocationRows([
      project('batch-old', { priority: 'batch', updatedAt: 1 }),
      project('project-new', { priority: 'project', updatedAt: 20 }),
      project('project-old', { priority: 'project', updatedAt: 10 }),
      project('live', { priority: 'interactive', updatedAt: 5 }),
    ]);
    expect(rows.map((p) => p.slug)).toEqual(['live', 'project-new', 'project-old', 'batch-old']);
  });

  it('leaves finished projects out of the running order', () => {
    const rows = allocationRows([
      project('done', { status: 'done' }),
      project('paused', { status: 'paused' }),
      project('active'),
    ]);
    expect(rows.map((p) => p.slug).sort()).toEqual(['active', 'paused']);
  });

  it('leaves the caller array alone', () => {
    const given = [project('b', { priority: 'batch' }), project('a', { priority: 'interactive' })];
    allocationRows(given);
    expect(given.map((p) => p.slug)).toEqual(['b', 'a']);
  });
});

describe('priorityLabel', () => {
  it('maps each priority to its plain-English word', () => {
    expect(priorityLabel('interactive')).toBe('Runs first');
    expect(priorityLabel('project')).toBe('Normal');
    expect(priorityLabel('batch')).toBe('When idle');
  });

  it('covers every key of PRIORITY_RANK', () => {
    for (const key of Object.keys(PRIORITY_RANK) as Priority[]) {
      expect(typeof priorityLabel(key)).toBe('string');
      expect(priorityLabel(key).length).toBeGreaterThan(0);
    }
  });
});

function hubState(projects: ProjectManifest[]): HubState {
  return { nodes: [], agents: [], jobs: [], streams: {}, projects };
}

function uiState(overrides: Partial<UiState> = {}): UiState {
  return {
    hub: null, busy: new Set(), projectBusy: new Set(), page: 'projects',
    project: null, prdSeed: null, connection: 'down', browserFrame: null, turns: {},
    ...overrides,
  };
}

describe('projectsSignature', () => {
  it('changes when the selected project changes', () => {
    const hub = hubState([project('a'), project('b')]);
    const s1 = projectsSignature(uiState({ hub, project: 'a' }));
    const s2 = projectsSignature(uiState({ hub, project: 'b' }));
    expect(s1).not.toBe(s2);
  });

  it('changes when the selected project is only touched — updatedAt moves with title/status/priority unchanged', () => {
    const before = uiState({ hub: hubState([project('a', { updatedAt: 1 })]), project: 'a' });
    const after = uiState({ hub: hubState([project('a', { updatedAt: 2 })]), project: 'a' });
    expect(projectsSignature(before)).not.toBe(projectsSignature(after));
  });

  it('changes when the hub first answers with no projects at all', () => {
    const before = uiState({ hub: null, project: null });
    const after = uiState({ hub: hubState([]), project: null });
    expect(projectsSignature(before)).not.toBe(projectsSignature(after));
  });

  it('is stable when nothing relevant changed', () => {
    const state = uiState({ hub: hubState([project('a', { updatedAt: 1 })]), project: 'a' });
    expect(projectsSignature(state)).toBe(projectsSignature(state));
  });

  it('changes when who is mid-reply changes', () => {
    const hub = hubState([project('a')]);
    const s1 = projectsSignature(uiState({ hub, project: 'a', projectBusy: new Set() }));
    const s2 = projectsSignature(uiState({ hub, project: 'a', projectBusy: new Set(['a:coder-1']) }));
    expect(s1).not.toBe(s2);
  });
});

describe('managerCard', () => {
  const roster: TeamRoster = {
    members: [{ id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', status: 'idle', sessionsCount: 0, createdAt: 0 }],
    manager: { status: 'idle' },
  };

  it('is the very card the org chart draws, so the header opens the Manager card’s own drawer', () => {
    expect(managerCard(roster)).toEqual(
      orgChartModel(roster).flatMap((tier) => tier.cards).find((card) => card.kind === 'manager'),
    );
  });

  it('carries the id the chat routes are built from', () => {
    expect(managerCard(roster)).toMatchObject({ id: 'manager', kind: 'manager', name: 'Manager' });
  });

  it('is there before the roster lands, so Chat works on a project still loading', () => {
    expect(managerCard(null)).toMatchObject({ id: 'manager', kind: 'manager' });
  });
});
