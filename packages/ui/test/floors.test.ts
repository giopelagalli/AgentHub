import { describe, it, expect } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { FLOORS, floorsFor } from '../src/floors.js';

describe('FLOORS', () => {
  it('has the exact order, ids, and labels for the static floors', () => {
    expect(FLOORS).toEqual([
      { id: 'b1', label: 'B1' },
      { id: 'f1', label: 'LOBBY' },
      { id: 'f2', label: 'STAFF' },
      { id: 'f5', label: 'SCREENING' },
      { id: 'ph', label: 'PH' },
    ]);
  });
});

function project(overrides: Partial<ProjectManifest>): ProjectManifest {
  return {
    schema: 1,
    slug: 'demo',
    title: 'Demo',
    status: 'active',
    priority: 'project',
    intent: '',
    links: [],
    createdAt: 0,
    updatedAt: 0,
    index: [],
    ...overrides,
  };
}

function hubState(projects: ProjectManifest[]): { hub: HubState } {
  return { hub: { nodes: [], agents: [], jobs: [], streams: {}, projects } };
}

describe('floorsFor', () => {
  it('is just the static floors when there is no hub state', () => {
    expect(floorsFor({ hub: null })).toEqual(FLOORS);
  });

  it('is just the static floors when the hub has no projects', () => {
    expect(floorsFor(hubState([]))).toEqual(FLOORS);
  });

  it('inserts one floor per non-done project before the screening room', () => {
    const floors = floorsFor(
      hubState([project({ slug: 'acme', title: 'Acme' }), project({ slug: 'zeta', title: 'Zeta' })]),
    );
    expect(floors.map((f) => f.id)).toEqual(['b1', 'f1', 'f2', 'p:acme', 'p:zeta', 'f5', 'ph']);
    expect(floors.map((f) => f.label)).toEqual([
      'B1',
      'LOBBY',
      'STAFF',
      'ACME',
      'ZETA',
      'SCREENING',
      'PH',
    ]);
  });

  it('filters out done projects', () => {
    const floors = floorsFor(
      hubState([
        project({ slug: 'acme', title: 'Acme', status: 'done' }),
        project({ slug: 'zeta', title: 'Zeta', status: 'active' }),
      ]),
    );
    expect(floors.map((f) => f.id)).toEqual(['b1', 'f1', 'f2', 'p:zeta', 'f5', 'ph']);
  });

  it('keeps paused/blocked projects on the tower', () => {
    const floors = floorsFor(
      hubState([
        project({ slug: 'a', status: 'paused' }),
        project({ slug: 'b', status: 'blocked' }),
      ]),
    );
    expect(floors.map((f) => f.id)).toEqual(['b1', 'f1', 'f2', 'p:a', 'p:b', 'f5', 'ph']);
  });

  it('uppercases and truncates the title to 12 chars plus an ellipsis', () => {
    const floors = floorsFor(hubState([project({ slug: 'x', title: 'a very long project title indeed' })]));
    expect(floors[3].label).toBe('A VERY LONG…');
  });

  it('leaves a short title untouched apart from case', () => {
    const floors = floorsFor(hubState([project({ slug: 'x', title: 'short' })]));
    expect(floors[3].label).toBe('SHORT');
  });
});
