import { parseGithubSource } from '@agenthub/shared';

/**
 * What the New Project wizard has to work out before it can post anything: the slug the title
 * implies, whether the owner's edit of it is still legal, the one-line intent the project list
 * will show, and the body it posts. Pure — the DOM lives in `panels/wizard.ts`.
 */

/**
 * What this form accepts as a project slug. The hub's own rule is `^[a-z0-9-]{1,40}$`; this is a
 * deliberately stricter subset — at least two characters and never opening on a dash — so anything
 * the wizard lets through, the hub will take. The length cap is the hub's, not ours to relax.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

const MAX_SLUG = 40;
/** The project list shows the intent as one line, so there is no point carrying more than this. */
export const MAX_INTENT = 200;

/** Where the project starts from: a paragraph to expand, a document to adopt, or a repository. */
export type Source = 'idea' | 'prd' | 'repo';

/** The slug a title implies. Empty when the title has nothing slug-able in it. */
export function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

/** The complaint to show under the slug field, or null when it is fine. */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'A slug is required.';
  if (slug.length < 2) return 'At least 2 characters.';
  if (slug.length > MAX_SLUG) return `At most ${MAX_SLUG} characters.`;
  if (!SLUG_PATTERN.test(slug)) {
    return 'Lowercase letters, numbers and dashes only, starting with a letter or number.';
  }
  return null;
}

/**
 * The one-line intent posted with the project: the opening of the idea, or — when a PRD was
 * pasted — its first heading, which is the closest thing a document has to a title.
 */
export function intentFrom(source: Source, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  // An import is prose too — the owner's "what do you want done?", which is what the list shows.
  if (source !== 'prd') return clean.slice(0, MAX_INTENT);

  for (const line of text.split('\n')) {
    const heading = /^\s*#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) return heading[1].slice(0, MAX_INTENT);
  }
  return clean.slice(0, MAX_INTENT);
}

/**
 * The complaint to show under the Repository field, or null when it names one. The check is the
 * hub's own parser, so a repository this accepts is one the hub will take — and when a repository
 * *picker* replaces the free-text field, this stays as the fallback for a typed-in name.
 */
export function repoProblem(input: string): string | null {
  if (!input.trim()) return 'A repository is required.';
  return parseGithubSource(input) ? null : 'Use owner/repo, or a github.com URL.';
}

/** Exactly what the wizard's Continue posts to `POST /api/projects`. */
export interface WizardPayload {
  slug: string;
  title: string;
  intent: string;
  priority: 'project';
  idea?: string;
  prd?: string;
  source?: { url: string; branch?: string };
}

export interface WizardInput {
  source: Source;
  slug: string;
  title: string;
  /** The paragraph, or the pasted PRD. For an import it is "what do you want done?". */
  text: string;
  /** Import only: what the owner typed in Repository, and the branch when they named one. */
  repo?: string;
  branch?: string;
}

/**
 * The creation body for a filled-in form. Pure, and deliberately the only place that knows how the
 * three sources map onto the hub's fields: an import posts its paragraph as the `idea` the drafter
 * works from *and* the `source` the hub clones, which is what makes the PRD come out of both.
 */
export function wizardPayload(input: WizardInput): WizardPayload {
  const text = input.text.trim();
  const base = {
    slug: input.slug,
    title: input.title,
    intent: intentFrom(input.source, text),
    priority: 'project' as const,
  };
  if (input.source === 'prd') return { ...base, prd: text };
  if (input.source === 'idea') return { ...base, idea: text };
  const branch = (input.branch ?? '').trim();
  return {
    ...base,
    idea: text,
    source: { url: (input.repo ?? '').trim(), ...(branch ? { branch } : {}) },
  };
}
