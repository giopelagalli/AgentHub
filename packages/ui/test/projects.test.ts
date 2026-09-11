import { describe, it, expect } from 'vitest';
import type { HubState, Priority, ProjectManifest, ProjectStatus } from '@agenthub/shared';
import type { UiState } from '../src/store.js';
import { allocationRows } from '../src/pages/allocation.js';
import { filterProjects, projectsSignature, stepSelection } from '../src/pages/projects.js';

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

const list = [
  project('acme-portal', { title: 'Acme Portal' }),
  project('beta-site', { title: 'Beta Site' }),
  project('gamma', { title: 'Gamma Rework' }),
];

describe('filterProjects', () => {
  it('returns everything for an empty or blank query', () => {
    expect(filterProjects(list, '')).toEqual(list);
    expect(filterProjects(list, '   ')).toEqual(list);
  });

  it('matches title or slug, case-insensitively', () => {
    expect(filterProjects(list, 'acme').map((p) => p.slug)).toEqual(['acme-portal']);
    expect(filterProjects(list, 'SITE').map((p) => p.slug)).toEqual(['beta-site']);
    expect(filterProjects(list, 'rework').map((p) => p.slug)).toEqual(['gamma']);
  });

  it('comes back empty when nothing matches', () => {
    expect(filterProjects(list, 'zzz')).toEqual([]);
  });
});

describe('stepSelection', () => {
  it('moves one row and stops at the ends', () => {
    expect(stepSelection(list, 'acme-portal', 1)).toBe('beta-site');
    expect(stepSelection(list, 'beta-site', -1)).toBe('acme-portal');
    expect(stepSelection(list, 'acme-portal', -1)).toBe('acme-portal');
    expect(stepSelection(list, 'gamma', 1)).toBe('gamma');
  });

  it('lands on the first row when nothing is selected or the selection was filtered out', () => {
    expect(stepSelection(list, null, 1)).toBe('acme-portal');
    expect(stepSelection(list, 'gone', -1)).toBe('acme-portal');
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepSelection([], 'acme-portal', 1)).toBeNull();
  });
});

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

function hubState(projects: ProjectManifest[]): HubState {
  return { nodes: [], agents: [], jobs: [], streams: {}, projects };
}

function uiState(overrides: Partial<UiState> = {}): UiState {
  return {
    hub: null, busy: new Set(), projectBusy: new Set(), page: 'projects',
    project: null, connection: 'down', browserFrame: null,
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
