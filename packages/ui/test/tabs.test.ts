import { describe, it, expect } from 'vitest';
import { DEFAULT_TAB, PROJECT_TABS, activeTab, rememberTab, stepTab, tabModel, type TabId } from '../src/tabs.js';

describe('tabModel', () => {
  it('lists every tab in strip order', () => {
    expect(tabModel('team').map((t) => t.id)).toEqual(['team', 'prd', 'roadmap', 'docs']);
    expect(tabModel('team').map((t) => t.id)).toEqual(PROJECT_TABS.map((t) => t.id));
  });

  it('marks exactly the tab being shown', () => {
    expect(tabModel('roadmap').filter((t) => t.current).map((t) => t.id)).toEqual(['roadmap']);
  });

  it('carries the label through', () => {
    expect(tabModel('team').find((t) => t.id === 'prd')?.label).toBe('PRD');
  });
});

describe('stepTab', () => {
  it('moves one tab in each direction', () => {
    expect(stepTab('team', 1)).toBe('prd');
    expect(stepTab('roadmap', -1)).toBe('prd');
  });

  it('wraps at both ends, the way a tablist does', () => {
    expect(stepTab('docs', 1)).toBe('team');
    expect(stepTab('team', -1)).toBe('docs');
  });
});

describe('activeTab', () => {
  it('opens on Team when nothing is remembered', () => {
    expect(activeTab({}, 'acme')).toBe(DEFAULT_TAB);
    expect(activeTab({ acme: 'docs' }, null)).toBe(DEFAULT_TAB);
  });

  it('remembers per project, not globally', () => {
    const memory: Record<string, TabId> = { acme: 'prd', beta: 'docs' };
    expect(activeTab(memory, 'acme')).toBe('prd');
    expect(activeTab(memory, 'beta')).toBe('docs');
    expect(activeTab(memory, 'gamma')).toBe('team');
  });

  it('ignores a remembered value that is not a tab', () => {
    expect(activeTab({ acme: 'gone' as TabId }, 'acme')).toBe('team');
  });
});

describe('rememberTab', () => {
  it('records the tab without touching what it was given', () => {
    const before: Record<string, TabId> = { acme: 'prd' };
    const after = rememberTab(before, 'beta', 'roadmap');
    expect(after).toEqual({ acme: 'prd', beta: 'roadmap' });
    expect(before).toEqual({ acme: 'prd' });
  });

  it('moves a project that was already remembered', () => {
    expect(rememberTab({ acme: 'prd' }, 'acme', 'docs')).toEqual({ acme: 'docs' });
  });
});
