import { describe, it, expect } from 'vitest';
import type { Priority, ProjectManifest, ProjectStatus } from '@agenthub/shared';
import { RAIL_PAGES, filterProjects, railModel, readCollapsed, stepSelection, writeCollapsed } from '../src/rail.js';

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
  it('links to the three whole-app pages, and not to the projects view', () => {
    expect(railModel('projects', false).entries.map((e) => e.id)).toEqual(['computer', 'cluster', 'allocation']);
    expect(railModel('projects', false).entries.map((e) => e.id)).toEqual(RAIL_PAGES.map((p) => p.id));
  });

  it('marks exactly the page being shown', () => {
    expect(railModel('cluster', false).entries.filter((e) => e.current).map((e) => e.id)).toEqual(['cluster']);
  });

  it('marks no page while a project is in the main area', () => {
    expect(railModel('projects', false).entries.some((e) => e.current)).toBe(false);
  });

  it('carries the label, the hint and the strip initial through untouched', () => {
    const computer = railModel('projects', false).entries.find((e) => e.id === 'computer');
    expect(computer?.label).toBe('Computer');
    expect(computer?.hint).toBe('Shared browser');
    expect(computer?.initial).toBe('Co');
  });

  it('gives each page its own initial, so the strip stays readable', () => {
    const initials = RAIL_PAGES.map((p) => p.initial);
    expect(new Set(initials).size).toBe(initials.length);
  });

  it('keeps the page links either way, and spells New project out only when expanded', () => {
    const wide = railModel('computer', false);
    const strip = railModel('computer', true);
    expect(strip.entries.map((e) => e.id)).toEqual(wide.entries.map((e) => e.id));
    expect(wide.newProjectLabel).toBe('New project');
    expect(strip.newProjectLabel).toBe('+');
  });

  it('gives up the project list for the strip, and says what the chevron does next', () => {
    expect(railModel('projects', false).showsProjects).toBe(true);
    expect(railModel('projects', true).showsProjects).toBe(false);
    expect(railModel('projects', false).toggleLabel).toBe('Collapse the rail');
    expect(railModel('projects', true).toggleLabel).toBe('Expand the rail');
  });

  it('reports the width it was given', () => {
    expect(railModel('projects', true).collapsed).toBe(true);
    expect(railModel('projects', false).collapsed).toBe(false);
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
