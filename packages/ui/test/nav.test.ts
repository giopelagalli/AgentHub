import { describe, it, expect } from 'vitest';
import { PAGES, navModel } from '../src/nav.js';

describe('navModel', () => {
  it('lists every page in nav order', () => {
    expect(navModel('projects').map((e) => e.id)).toEqual(PAGES.map((p) => p.id));
    expect(navModel('projects').map((e) => e.id)).toEqual(['projects', 'computer', 'cluster', 'allocation']);
  });

  it('marks exactly the page being shown', () => {
    const entries = navModel('cluster');
    expect(entries.filter((e) => e.current).map((e) => e.id)).toEqual(['cluster']);
  });

  it('carries the label and hint through untouched', () => {
    const computer = navModel('projects').find((e) => e.id === 'computer');
    expect(computer?.label).toBe('Computer');
    expect(computer?.hint).toBe('Shared browser');
  });
});
