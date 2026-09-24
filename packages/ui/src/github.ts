/**
 * What the pages need to know about the hub's GitHub connection, as pure functions: the shape
 * `GET /api/github/status` answers with, which of the four repository fields that implies, and the
 * lines shown beside them. The DOM lives in `panels/wizard.ts`.
 */

export interface GithubInstallationView {
  id: number;
  login: string;
  type: string;
  manageUrl: string;
}

/** `GET /api/github/status`. A hub too old to know about the App answers only the first two. */
export interface GithubStatus {
  configured: boolean;
  method: 'app' | 'token' | 'none';
  connected?: boolean;
  /** Where Connect GitHub points; present only when the hub has an App registered. */
  installUrl?: string;
  installations?: GithubInstallationView[];
}

/** One row of `GET /api/github/repos`. */
export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

/**
 * What the Repository field offers, on top of the free-text input that is always there:
 *
 * - `picker` — the member's connected repositories, chosen from a list.
 * - `connect` — the Connect GitHub button: an App is registered but they haven't used it.
 * - `typed` — nothing extra; the hub has a personal access token and they type the name.
 * - `none` — nothing extra, and a line saying private repositories are out of reach.
 */
export type RepoFieldMode = 'picker' | 'connect' | 'typed' | 'none';

export function repoFieldMode(status: GithubStatus): RepoFieldMode {
  if (status.method === 'app') return status.connected ? 'picker' : 'connect';
  if (status.method === 'token') return 'typed';
  return 'none';
}

/** The one line under the Connect button: what pressing it actually does. */
export const CONNECT_NOTE =
  'Pick the repositories AgentHub may use; you can change them on GitHub any time.';

/** The line under the Repository field for each mode. */
export function repoFieldNote(status: GithubStatus): string {
  switch (repoFieldMode(status)) {
    case 'picker':
      return `Connected as ${accountLogins(status).join(', ')}.`;
    case 'connect':
      return CONNECT_NOTE;
    case 'typed':
      return 'Private repos use the GitHub token on the hub.';
    default:
      return 'Private repos need GitHub connected on the hub — public ones clone without it.';
  }
}

/** The accounts the member connected, in the order the hub listed them. */
export function accountLogins(status: GithubStatus): string[] {
  return (status.installations ?? []).map((i) => i.login);
}

/** The Cluster page's one line: how this hub reaches GitHub, in the fewest words that say it. */
export function githubLineText(status: GithubStatus | null): string {
  if (!status) return 'GitHub: reading…';
  switch (repoFieldMode(status)) {
    case 'picker': return `GitHub: connected as ${accountLogins(status).join(', ')}`;
    case 'connect': return 'GitHub: not connected';
    case 'typed': return 'GitHub: a token on the hub';
    default: return 'GitHub: not configured';
  }
}

/** `owner/repo · private · main` — one repository as the picker lists it. */
export function repoLabel(repo: GithubRepo): string {
  return [repo.fullName, repo.private ? 'private' : null, repo.defaultBranch]
    .filter(Boolean).join(' · ');
}

/**
 * What the `?github=` the callback redirects back with is telling us, or null when it says nothing.
 * The query is cleaned off the URL afterwards so a reload doesn't toast again.
 */
export function githubReturn(search: string): 'connected' | null {
  return new URLSearchParams(search).get('github') === 'connected' ? 'connected' : null;
}

/** The same URL without the `github` parameter — what replaces it in the address bar. */
export function withoutGithubParam(href: string): string {
  const url = new URL(href, 'http://hub.invalid');
  url.searchParams.delete('github');
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
}
