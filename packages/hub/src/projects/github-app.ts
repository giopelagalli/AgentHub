import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GithubCredentials } from './github.js';
import type { GithubInstallations } from './github-installations.js';

/**
 * The GitHub App half of the GitHub integration: the app's own JWT, the installation tokens it
 * mints, the OAuth leg of the install flow, and the state a connect round trip carries.
 *
 * It exists so a member can connect GitHub with a button instead of minting a personal access
 * token: they press Connect, GitHub shows its own "choose repositories" screen, and what comes back
 * is an *installation*, which this module turns into a short-lived token per repository. Nothing
 * here is ever logged and nothing here reaches the UI — `github.ts` remains the only module that
 * uses a token, and `AppCredentials` is simply a second `GithubCredentials` beside `PatCredentials`.
 */

/** The five values from `hub.env`; `privateKey` is the `.pem`'s contents, read at startup. */
export interface GithubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** The app's URL slug, which is what `https://github.com/apps/<slug>/installations/new` needs. */
  slug: string;
}

/** Where github.com itself lives (the install page and the OAuth token endpoint). */
export const GITHUB_WEB_BASE = 'https://github.com';

/** An app JWT may live at most 10 minutes; well under it, so a slow clock still verifies. */
const JWT_TTL_SEC = 540;
/** Clock skew allowed on `iat`, as GitHub's own docs recommend. */
const JWT_BACKDATE_SEC = 60;
/** An installation token is good for an hour; it is dropped this long before GitHub expires it. */
const TOKEN_EARLY_EXPIRY_MS = 5 * 60 * 1000;
/** How long a listing of an installation's repositories is reused. */
export const REPO_CACHE_MS = 5 * 60 * 1000;
/** Pages of 100 repositories to walk before giving up on an enormous installation. */
const MAX_REPO_PAGES = 5;
/** How long a connect round trip may take before its `state` stops verifying. */
export const CONNECT_STATE_TTL_MS = 15 * 60 * 1000;

const base64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');

/**
 * The app's own credential: a JWT signed RS256 with the private key, proving "I am app <appId>".
 * Signed with Node's `crypto` rather than a JWT library — this is the only JWT the hub ever makes,
 * and the whole of it is three base64url segments, so a dependency would buy nothing.
 */
export function appJwt(config: GithubAppConfig, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: seconds - JWT_BACKDATE_SEC,
    exp: seconds + JWT_TTL_SEC,
    iss: config.appId,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(config.privateKey))}`;
}

/**
 * The `state` a connect round trip carries: a random nonce, the member it was minted for and an
 * expiry, signed with the hub's session key. Nothing is stored — the signature *is* the record, so
 * a restart mid-connect costs nothing and there is no table of pending connects to expire.
 *
 * It is not a session: the callback is an owner route, so the browser has to present the session
 * cookie anyway. What the state adds is that the install being reported was started by this hub,
 * from this member's own press of the button.
 */
export class ConnectState {
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  sign(user: string): string {
    const payload = `${randomBytes(12).toString('hex')}.${base64url(user)}.${this.now() + CONNECT_STATE_TTL_MS}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /** The member the state was minted for, or null when it is forged, mangled or stale. */
  verify(state: string | undefined): string | null {
    if (!state) return null;
    const parts = state.split('.');
    if (parts.length !== 4) return null;
    const [, user, exp, mac] = parts;
    const expected = this.mac(parts.slice(0, 3).join('.'));
    if (mac.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    if (!/^\d+$/.test(exp) || Number(exp) <= this.now()) return null;
    try {
      return Buffer.from(user, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}

/** One installation as GitHub describes it: which account it is on, and of what kind. */
export interface InstallationAccount {
  id: number;
  login: string;
  type: string;
}

/** A repository an installation can reach, as `GET /api/github/repos` reports it. */
export interface GithubRepoSummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface GithubAppClientOptions {
  config: GithubAppConfig;
  /** Test seam for every call; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** `https://api.github.com` unless a test points it somewhere else. */
  apiBase?: string;
  /** `https://github.com` — the install page and the OAuth token endpoint. */
  webBase?: string;
  now?: () => number;
}

export class GithubAppError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GithubAppError';
  }
}

/**
 * Every call the app itself makes to GitHub. Stateless: no caching, no database, no knowledge of
 * which installations this hub has seen — that is `AppCredentials`' job.
 */
export class GithubAppClient {
  readonly config: GithubAppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly webBase: string;
  private readonly now: () => number;

  constructor(opts: GithubAppClientOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetch ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
    this.webBase = opts.webBase ?? GITHUB_WEB_BASE;
    this.now = opts.now ?? Date.now;
  }

  /** Where Connect sends the browser: GitHub's own "choose repositories" screen. */
  installUrl(state?: string): string {
    const base = `${this.webBase}/apps/${encodeURIComponent(this.config.slug)}/installations/new`;
    return state ? `${base}?state=${encodeURIComponent(state)}` : base;
  }

  /** Where "Manage on GitHub" sends them: the settings page for an installation they own. */
  manageUrl(installationId: number): string {
    return `${this.webBase}/settings/installations/${installationId}`;
  }

  /**
   * Trades the callback's `code` for a *user* access token. The token is used for exactly one
   * thing — asking GitHub which installations this person has — and is then dropped: everything
   * the hub does afterwards runs on installation tokens, which are narrower and short-lived.
   */
  async exchangeCode(code: string): Promise<string> {
    const body = await this.call(`${this.webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'AgentHub' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    const token = (body as { access_token?: unknown } | null)?.access_token;
    // The OAuth endpoint answers 200 with `{ error: 'bad_verification_code' }`, so a missing token
    // is the failure — never a status code.
    if (typeof token !== 'string' || !token) {
      const error = (body as { error_description?: unknown; error?: unknown } | null);
      const said = typeof error?.error_description === 'string' ? error.error_description
        : typeof error?.error === 'string' ? error.error : 'no access token';
      throw new GithubAppError(`GitHub refused the sign-in: ${said}`);
    }
    return token;
  }

  /** The GitHub login behind a user token — the person who just pressed Connect. */
  async userLogin(userToken: string): Promise<string> {
    const body = await this.call(`${this.apiBase}/user`, { headers: this.headers(`Bearer ${userToken}`) });
    const login = (body as { login?: unknown } | null)?.login;
    if (typeof login !== 'string') throw new GithubAppError('GitHub did not say who signed in');
    return login;
  }

  /**
   * The installations *this person* can see — their own account's and every organisation's they can
   * administer. This is the ownership check: GitHub warns that the `installation_id` on the
   * callback can be spoofed, and the only answer that holds is to ask the user's own token which
   * installations are theirs.
   */
  async userInstallations(userToken: string): Promise<{ id: number; account: InstallationAccount }[]> {
    const body = await this.call(
      `${this.apiBase}/user/installations?per_page=100`, { headers: this.headers(`Bearer ${userToken}`) },
    );
    const list = (body as { installations?: unknown } | null)?.installations;
    if (!Array.isArray(list)) return [];
    return list.flatMap((raw) => {
      const row = raw as { id?: unknown; account?: { id?: unknown; login?: unknown; type?: unknown } | null };
      const account = row.account;
      if (typeof row.id !== 'number' || !account || typeof account.login !== 'string') return [];
      return [{
        id: row.id,
        account: {
          id: typeof account.id === 'number' ? account.id : 0,
          login: account.login,
          type: typeof account.type === 'string' ? account.type : 'User',
        },
      }];
    });
  }

  /** A token scoped to one installation, good for an hour, with the expiry GitHub stamped on it. */
  async installationToken(installationId: number): Promise<{ token: string; expiresAt: number }> {
    const body = await this.call(`${this.apiBase}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: this.headers(`Bearer ${appJwt(this.config, this.now())}`),
    });
    const row = body as { token?: unknown; expires_at?: unknown } | null;
    if (typeof row?.token !== 'string') throw new GithubAppError('GitHub did not return an installation token');
    const expiresAt = typeof row.expires_at === 'string' ? Date.parse(row.expires_at) : NaN;
    return {
      token: row.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 60 * 60 * 1000,
    };
  }

  /** Every repository an installation reaches, paginated. */
  async installationRepos(token: string): Promise<GithubRepoSummary[]> {
    const out: GithubRepoSummary[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
      const body = await this.call(
        `${this.apiBase}/installation/repositories?per_page=100&page=${page}`,
        { headers: this.headers(`Bearer ${token}`) },
      );
      const list = (body as { repositories?: unknown } | null)?.repositories;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const raw of list) {
        const repo = raw as { full_name?: unknown; private?: unknown; default_branch?: unknown; updated_at?: unknown };
        if (typeof repo.full_name !== 'string') continue;
        out.push({
          fullName: repo.full_name,
          private: repo.private === true,
          defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
          updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : '',
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  private headers(authorization: string): Record<string, string> {
    return {
      authorization,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'AgentHub',
    };
  }

  /** One call, with GitHub's own `message` surfaced instead of a bare status. */
  private async call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new GithubAppError(`could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = (body as { message?: unknown } | null)?.message;
      throw new GithubAppError(
        typeof message === 'string' ? message : `GitHub replied ${response.status}`, response.status,
      );
    }
    return body;
  }
}

/**
 * A `GithubCredentials` backed by the app's installations: `tokenFor(owner, repo)` finds the
 * installation that covers the repository and mints a token for it, cached until shortly before
 * GitHub expires it.
 *
 * The lookup is the account name first — an installation on `acme` covers `acme/*` — and only when
 * that misses does it walk each installation's repository list, which is how a repository shared
 * with the member through an organisation they do not own still resolves.
 */
export class AppCredentials implements GithubCredentials {
  readonly method = 'app' as const;

  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly repos = new Map<number, { at: number; list: GithubRepoSummary[] }>();

  constructor(
    private readonly client: GithubAppClient,
    private readonly installations: GithubInstallations,
    private readonly user: string,
    private readonly now: () => number = Date.now,
  ) {}

  async tokenFor(owner: string, repo: string): Promise<string | null> {
    const rows = this.installations.list(this.user);
    const byAccount = rows.find((row) => row.accountLogin.toLowerCase() === owner.toLowerCase());
    if (byAccount) return (await this.token(byAccount.installationId)).token;
    const wanted = `${owner}/${repo}`.toLowerCase();
    for (const row of rows) {
      const list = await this.repositories(row.installationId).catch(() => []);
      if (list.some((r) => r.fullName.toLowerCase() === wanted)) {
        return (await this.token(row.installationId)).token;
      }
    }
    return null;
  }

  /** Every repository the member's installations reach, newest first — what the picker shows. */
  async repositoriesFor(user: string): Promise<GithubRepoSummary[]> {
    const seen = new Map<string, GithubRepoSummary>();
    for (const row of this.installations.list(user)) {
      for (const repo of await this.repositories(row.installationId).catch(() => [])) {
        if (!seen.has(repo.fullName)) seen.set(repo.fullName, repo);
      }
    }
    return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Forgets what is cached for one installation — called when it is disconnected. */
  forget(installationId: number): void {
    this.tokens.delete(installationId);
    this.repos.delete(installationId);
  }

  private async token(installationId: number): Promise<{ token: string; expiresAt: number }> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_EARLY_EXPIRY_MS > this.now()) return cached;
    const minted = await this.client.installationToken(installationId);
    this.tokens.set(installationId, minted);
    return minted;
  }

  private async repositories(installationId: number): Promise<GithubRepoSummary[]> {
    const cached = this.repos.get(installationId);
    if (cached && this.now() - cached.at < REPO_CACHE_MS) return cached.list;
    const { token } = await this.token(installationId);
    const list = await this.client.installationRepos(token);
    this.repos.set(installationId, { at: this.now(), list });
    return list;
  }
}
