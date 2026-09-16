/**
 * What the New Project wizard has to work out before it can post anything: the slug the title
 * implies, whether the owner's edit of it is still legal, and the one-line intent the project
 * list will show. Pure — the DOM lives in `panels/wizard.ts`.
 */

/** What the hub accepts as a project slug: 2–63 chars, lowercase, starting on a letter or digit. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

const MAX_SLUG = 63;
/** The project list shows the intent as one line, so there is no point carrying more than this. */
export const MAX_INTENT = 200;

/** Where the project starts from: a paragraph to expand, or a document to adopt. */
export type Source = 'idea' | 'prd';

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
  if (source === 'idea') return clean.slice(0, MAX_INTENT);

  for (const line of text.split('\n')) {
    const heading = /^\s*#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) return heading[1].slice(0, MAX_INTENT);
  }
  return clean.slice(0, MAX_INTENT);
}
