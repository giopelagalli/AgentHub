import { describe, it, expect } from 'vitest';
import type { Priority, ProjectManifest, ProjectStatus } from '@agenthub/shared';
import { MACHINE_PAGES, RAIL_PAGES, filterProjects, placeOf, projectDot, railModel, readCollapsed, stepSelection, writeCollapsed } from '../src/rail.js';
import type { UiState } from '../src/store.js';
import type { TurnRecord } from '../src/turns.js';

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

describe('railModel', () => {
  it('links to the two system places, and not to the projects view', () => {
    expect(railModel('projects', false).entries.map((e) => e.id)).toEqual(['machines', 'help']);
    expect(railModel('projects', false).entries.map((e) => e.id)).toEqual(RAIL_PAGES.map((p) => p.id));
  });

  it('marks Machines on any of its four sections, and Help on Help', () => {
    for (const page of MACHINE_PAGES) {
      expect(railModel(page, false).entries.filter((e) => e.current).map((e) => e.id)).toEqual(['machines']);
    }
    expect(railModel('help', false).entries.filter((e) => e.current).map((e) => e.id)).toEqual(['help']);
  });

  it('marks no place while a project is in the main area', () => {
    expect(railModel('projects', false).entries.some((e) => e.current)).toBe(false);
  });

  it('carries the label, the icon and the landing page through untouched', () => {
    const machines = railModel('projects', false).entries.find((e) => e.id === 'machines');
    expect(machines?.label).toBe('Machines');
    expect(machines?.icon).toBe('machines');
    expect(machines?.page).toBe('cluster');
  });

  it('keeps the same places either way, and says what the sidebar button does next', () => {
    expect(railModel('help', true).entries.map((e) => e.id)).toEqual(railModel('help', false).entries.map((e) => e.id));
    expect(railModel('projects', false).toggleLabel).toBe('Hide the sidebar');
    expect(railModel('projects', true).toggleLabel).toBe('Show the sidebar');
  });

  it('reports the state it was given', () => {
    expect(railModel('projects', true).collapsed).toBe(true);
    expect(railModel('projects', false).collapsed).toBe(false);
  });
});

describe('placeOf', () => {
  it('folds the four machine sections into Machines and leaves a project in no place', () => {
    expect(placeOf('cluster')).toBe('machines');
    expect(placeOf('computer')).toBe('machines');
    expect(placeOf('allocation')).toBe('machines');
    expect(placeOf('access')).toBe('machines');
    expect(placeOf('help')).toBe('help');
    expect(placeOf('projects')).toBeNull();
  });
});

describe('projectDot', () => {
  const state = (turns: TurnRecord[] = [], slug = 'acme-portal'): UiState => ({
    hub: null, busy: new Set(), projectBusy: new Set(), page: 'projects', project: slug, prdSeed: null,
    connection: 'live', browserFrame: null, turns: { [slug]: { state: 'ready', turns } },
  });
  const turn = (overrides: Partial<TurnRecord>): TurnRecord => ({
    sessionId: 1, startedAt: 0, endedAt: 1, outcome: 'completed', summary: '', toolCalls: 0,
    cost: { usd: 0, tokens: 0 }, events: [], ...overrides,
  });

  it('is green while a turn runs, whatever the status says', () => {
    expect(projectDot(project('acme-portal', { status: 'paused' }), state([turn({ endedAt: null, outcome: null })]))).toBe('working');
  });

  it('reads paused, done and blocked off the status', () => {
    expect(projectDot(project('acme-portal', { status: 'paused' }), state())).toBe('paused');
    expect(projectDot(project('acme-portal', { status: 'done' }), state())).toBe('done');
    expect(projectDot(project('acme-portal', { status: 'blocked' }), state())).toBe('needs');
  });

  it('is red after a failed turn and grey after a good one', () => {
    expect(projectDot(project('acme-portal'), state([turn({ outcome: 'failed' })]))).toBe('error');
    expect(projectDot(project('acme-portal'), state([turn({ outcome: 'completed' })]))).toBe('idle');
    expect(projectDot(project('acme-portal'), state())).toBe('idle');
  });
});

describe('rail width memory', () => {
  it('opens wide, and stays quiet, where there is no storage to read', () => {
    expect(readCollapsed()).toBe(false);
    expect(() => writeCollapsed(true)).not.toThrow();
  });
});

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
