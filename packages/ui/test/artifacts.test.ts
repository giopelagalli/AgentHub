import { describe, it, expect } from 'vitest';
import { docsSummary, prdSummary, roadmapSummary } from '../src/artifacts.js';
import type { DocsIndex } from '../src/docs.js';
import type { PrdAuditSection, PrdDoc } from '../src/prd.js';
import type { RoadmapDoc } from '../src/roadmap.js';

function section(title: string, present: boolean, thin = false): PrdAuditSection {
  return { key: title.toLowerCase(), title, present, thin };
}

const drafted = (audit?: PrdDoc['audit']): PrdDoc => ({
  drafted: true,
  markdown: '# Overview\n',
  ...(audit ? { audit } : {}),
});

describe('prdSummary', () => {
  it('says so while it is being read, and when it could not be', () => {
    expect(prdSummary('loading', null).hint).toBe('Loading…');
    expect(prdSummary('failed', null).hint).toBe('Could not be read');
    expect(prdSummary('loading', null).filled).toBe(false);
  });

  it('points at the empty state when no PRD has been drafted', () => {
    expect(prdSummary('ready', null).hint).toBe('Not drafted yet');
    expect(prdSummary('ready', { drafted: false, markdown: '' }).hint).toBe('Not drafted yet');
    expect(prdSummary('ready', null).badge).toBeUndefined();
    expect(prdSummary('ready', null).filled).toBe(false);
  });

  it('shows the score, and counts the sections that still need work', () => {
    const summary = prdSummary('ready', drafted({
      score: 72,
      sections: [section('Overview', true), section('Goals', true, true), section('Risks', false)],
    }));
    expect(summary.badge).toBe('72%');
    expect(summary.hint).toBe('2 sections still thin');
    expect(summary.filled).toBe(true);
  });

  it('counts one thin section in the singular, and says nothing is short when nothing is', () => {
    expect(prdSummary('ready', drafted({ score: 90, sections: [section('Overview', true), section('Goals', false)] })).hint)
      .toBe('1 section still thin');
    expect(prdSummary('ready', drafted({ score: 100, sections: [section('Overview', true)] })).hint)
      .toBe('Every section covered');
  });

  it('shows no score at all where the hub graded nothing, rather than a bare 0%', () => {
    const summary = prdSummary('ready', drafted());
    expect(summary.badge).toBeUndefined();
    expect(summary.hint).toBe('Drafted');
    expect(summary.filled).toBe(true);
  });

  it('is labelled and captioned whatever the state', () => {
    expect(prdSummary('loading', null).label).toBe('PRD');
    expect(prdSummary('ready', null).id).toBe('prd');
    expect(prdSummary('ready', null).caption).toBe('What we are building');
  });
});

describe('roadmapSummary', () => {
  const doc = (milestones: RoadmapDoc['milestones'], currentId?: string): RoadmapDoc => ({
    milestones,
    ...(currentId ? { currentId } : {}),
  });
  const milestone = (id: string, title: string): RoadmapDoc['milestones'][number] =>
    ({ id, title, summary: '', status: 'planned' });

  it('says so while it is being read, and when it could not be', () => {
    expect(roadmapSummary('loading', null).hint).toBe('Loading…');
    expect(roadmapSummary('failed', null).hint).toBe('Could not be read');
  });

  it('points at the empty state when there are no milestones', () => {
    expect(roadmapSummary('ready', null).hint).toBe('No milestones yet');
    expect(roadmapSummary('ready', doc([])).hint).toBe('No milestones yet');
    expect(roadmapSummary('ready', doc([])).filled).toBe(false);
  });

  it('counts the milestones and names the one being worked on', () => {
    const summary = roadmapSummary('ready', doc([milestone('m1', 'Ship the shell'), milestone('m2', 'Wire the hub')], 'm2'));
    expect(summary.hint).toBe('2 milestones · current: Wire the hub');
    expect(summary.filled).toBe(true);
  });

  it('says nothing has started when no milestone is current', () => {
    expect(roadmapSummary('ready', doc([milestone('m1', 'Ship the shell')])).hint)
      .toBe('1 milestone · nothing started');
  });

  it('names an untitled milestone the way the list does', () => {
    expect(roadmapSummary('ready', doc([milestone('m1', '  ')], 'm1')).hint)
      .toBe('1 milestone · current: Untitled milestone');
  });
});

describe('docsSummary', () => {
  it('says so while it is being read, and when it could not be', () => {
    expect(docsSummary('loading', null).hint).toBe('Loading…');
    expect(docsSummary('failed', null).hint).toBe('Could not be read');
  });

  it('counts an empty bundle as no pages, decision log and all', () => {
    expect(docsSummary('ready', null).hint).toBe('No pages yet');
    expect(docsSummary('ready', {}).hint).toBe('No pages yet');
    expect(docsSummary('ready', { decisions: '   ' }).hint).toBe('No pages yet');
    expect(docsSummary('ready', {}).filled).toBe(false);
  });

  it('counts the overview, the bundle pages and a decision log that has something in it', () => {
    const bundle: DocsIndex = {
      index: '# Overview',
      pages: [{ slug: 'api', title: 'API' }, { slug: 'ops', title: 'Ops' }],
      decisions: '- chose SQLite',
    };
    expect(docsSummary('ready', bundle).hint).toBe('4 pages');
    expect(docsSummary('ready', bundle).filled).toBe(true);
  });

  it('counts one page in the singular', () => {
    expect(docsSummary('ready', { index: '# Overview' }).hint).toBe('1 page');
  });
});
