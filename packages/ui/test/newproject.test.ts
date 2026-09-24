import { describe, it, expect } from 'vitest';
import { parseGithubSource } from '@agenthub/shared';
import { SLUG_PATTERN, deriveSlug, intentFrom, repoProblem, slugProblem, wizardPayload } from '../src/newproject.js';

describe('deriveSlug', () => {
  it('lowercases and dashes a title', () => {
    expect(deriveSlug('Acme Portal')).toBe('acme-portal');
    expect(deriveSlug('Q4 — Billing Rework!')).toBe('q4-billing-rework');
  });

  it('collapses runs and trims the ends', () => {
    expect(deriveSlug('  ***Hello***  World  ')).toBe('hello-world');
    expect(deriveSlug('-leading and trailing-')).toBe('leading-and-trailing');
  });

  it('keeps digits, including a leading one', () => {
    expect(deriveSlug('2026 planning')).toBe('2026-planning');
  });

  it('comes back empty when there is nothing to slug', () => {
    expect(deriveSlug('???')).toBe('');
    expect(deriveSlug('')).toBe('');
  });

  it('never produces something the hub would reject', () => {
    const long = deriveSlug('a'.repeat(200));
    expect(long.length).toBe(40);
    expect(SLUG_PATTERN.test(long)).toBe(true);
    // Truncation must not leave the slug ending on a dash.
    expect(deriveSlug(`${'a'.repeat(39)} tail`)).toBe('a'.repeat(39));
  });
});

describe('slugProblem', () => {
  it('accepts a subset of what the hub accepts', () => {
    for (const slug of ['ab', 'acme-portal', 'a1', '2026-planning', 'a'.repeat(40)]) {
      expect(slugProblem(slug), slug).toBeNull();
    }
  });

  it('rejects an empty, too-short or too-long slug', () => {
    expect(slugProblem('')).toBe('A slug is required.');
    expect(slugProblem('a')).toBe('At least 2 characters.');
    expect(slugProblem('a'.repeat(41))).toBe('At most 40 characters.');
  });

  it('rejects uppercase, spaces, underscores and a leading dash', () => {
    for (const slug of ['Acme', 'acme portal', 'acme_portal', '-acme', 'acme.portal']) {
      expect(slugProblem(slug), slug).not.toBeNull();
    }
  });
});

describe('intentFrom', () => {
  it('takes the opening of an idea, on one line', () => {
    expect(intentFrom('idea', '  A portal\n  for invoices.  ')).toBe('A portal for invoices.');
  });

  it('caps the idea at 200 characters', () => {
    expect(intentFrom('idea', 'x'.repeat(500))).toHaveLength(200);
  });

  it('takes a pasted PRD’s first heading, whatever depth it is', () => {
    expect(intentFrom('prd', 'preamble\n\n## Billing rework\n\nbody')).toBe('Billing rework');
    expect(intentFrom('prd', '# Acme Portal\n## Later heading')).toBe('Acme Portal');
  });

  it('falls back to the opening text when a PRD has no heading', () => {
    expect(intentFrom('prd', 'just a wall\nof text')).toBe('just a wall of text');
  });

  it('has nothing to say about empty input', () => {
    expect(intentFrom('idea', '   ')).toBe('');
    expect(intentFrom('prd', '')).toBe('');
  });

  it('treats an import’s paragraph as prose, like an idea', () => {
    expect(intentFrom('repo', '  Add SSO\n  to the portal. ')).toBe('Add SSO to the portal.');
  });
});

describe('parseGithubSource', () => {
  it('takes the three spellings an owner is likely to paste', () => {
    for (const input of [
      'acme/portal',
      '  acme/portal  ',
      'https://github.com/acme/portal',
      'https://github.com/acme/portal.git',
      'https://github.com/acme/portal/',
      'http://www.github.com/acme/portal',
      'HTTPS://GitHub.com/acme/portal',
      'git@github.com:acme/portal.git',
      'git@github.com:acme/portal',
    ]) {
      expect(parseGithubSource(input), input).toEqual({ owner: 'acme', repo: 'portal' });
    }
  });

  it('keeps the dots and dashes a repository name is allowed', () => {
    expect(parseGithubSource('acme-inc/portal.js')).toEqual({ owner: 'acme-inc', repo: 'portal.js' });
    expect(parseGithubSource('https://github.com/acme/my_repo.git')).toEqual({ owner: 'acme', repo: 'my_repo' });
  });

  it('refuses another host, a deeper path, and anything that is not a name', () => {
    for (const input of [
      '', '   ', 'portal', 'acme/portal/tree/main', 'https://gitlab.com/acme/portal',
      'https://github.com/acme', 'https://evil.com/github.com/acme/portal',
      '-acme/portal', 'acme-/portal', 'acme/..', 'acme/.', 'ac me/portal', 'acme/por tal',
      `${'a'.repeat(40)}/portal`,
    ]) {
      expect(parseGithubSource(input), input).toBeNull();
    }
  });
});

describe('repoProblem', () => {
  it('is silent for a repository and complains about anything else', () => {
    expect(repoProblem('acme/portal')).toBeNull();
    expect(repoProblem('')).toBe('A repository is required.');
    expect(repoProblem('https://gitlab.com/acme/portal')).toBe('Use owner/repo, or a github.com URL.');
  });
});

describe('wizardPayload', () => {
  const base = { slug: 'portal', title: 'Portal' };

  it('posts an idea as an idea and a PRD as a PRD', () => {
    expect(wizardPayload({ ...base, source: 'idea', text: ' a portal for invoices ' }))
      .toEqual({ ...base, intent: 'a portal for invoices', priority: 'project', idea: 'a portal for invoices' });
    expect(wizardPayload({ ...base, source: 'prd', text: '# Billing rework\n\nbody' }))
      .toEqual({ ...base, intent: 'Billing rework', priority: 'project', prd: '# Billing rework\n\nbody' });
  });

  it('posts an import as both the source to clone and the idea to draft from', () => {
    expect(wizardPayload({ ...base, source: 'repo', text: 'Add SSO.', repo: ' acme/portal ', branch: ' develop ' }))
      .toEqual({
        ...base, intent: 'Add SSO.', priority: 'project', idea: 'Add SSO.',
        source: { url: 'acme/portal', branch: 'develop' },
      });
  });

  it('leaves the branch out when the owner did not name one', () => {
    for (const branch of [undefined, '', '   ']) {
      const payload = wizardPayload({ ...base, source: 'repo', text: 'Add SSO.', repo: 'acme/portal', branch });
      expect(payload.source).toEqual({ url: 'acme/portal' });
    }
  });
});
