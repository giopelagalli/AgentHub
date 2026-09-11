import { describe, it, expect } from 'vitest';
import type { HubState, ProjectManifest } from '@agenthub/shared';
import { tabsFor } from '../src/tabs.js';

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

describe('tabsFor', () => {
  it('is one tab per static floor when there is no hub state', () => {
    expect(tabsFor({ hub: null })).toEqual([
      { id: 'b1', label: 'B1' },
      { id: 'f1', label: 'LOBBY' },
      { id: 'f2', label: 'STAFF' },
      { id: 'f5', label: 'SCREENING' },
      { id: 'ph', label: 'PH' },
    ]);
  });

  it('grows a tab per live project, between the staff floor and the screening room', () => {
    const tabs = tabsFor(
      hubState([project({ slug: 'acme', title: 'Acme Portal' }), project({ slug: 'zeta', title: 'Zeta' })]),
    );
    expect(tabs).toEqual([
      { id: 'b1', label: 'B1' },
      { id: 'f1', label: 'LOBBY' },
      { id: 'f2', label: 'STAFF' },
      { id: 'p:acme', label: 'ACME PORTAL' },
      { id: 'p:zeta', label: 'ZETA' },
      { id: 'f5', label: 'SCREENING' },
      { id: 'ph', label: 'PH' },
    ]);
  });

  it('drops a finished project tab', () => {
    const tabs = tabsFor(hubState([project({ slug: 'acme', status: 'done' })]));
    expect(tabs.map((t) => t.id)).toEqual(['b1', 'f1', 'f2', 'f5', 'ph']);
  });

  it('truncates a long project title to fit a tab', () => {
    const tabs = tabsFor(hubState([project({ slug: 'x', title: 'a very long project title' })]));
    expect(tabs[3].label).toBe('A VERY LONG…');
  });
});
