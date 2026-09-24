import { simpleGit, type SimpleGit } from 'simple-git';
import type { GithubRepoRef, ProjectSource } from '@agenthub/shared';

/**
 * Everything the hub does with a GitHub repository: clone it into a project's workspace, push the
 * agents' branch back, and open the pull request the owner merges. One module because these three
 * are the only places a credential is used, and keeping them together is what makes "the token is
 * never logged and never leaves the hub" a property you can check by reading one file.
 */

/** The public host; `cloneBase` replaces it in tests, and production never accepts anything else. */
export const GITHUB_CLONE_BASE = 'https://github.com';
export const GITHUB_API_BASE = 'https://api.github.com';

/** How the hub found a token, as `GET /api/github/status` reports it. */
export type GithubAuthMethod = 'token' | 'none';

/**
 * Where a token for one repository comes from.
 *
 * A single personal access token in `hub.env` is the only implementation today, but it is
 * deliberately the *fallback*: a GitHub App installation mints a short-lived token per repository,
 * so the lookup is per repo and asynchronous from the start. Nothing below a call to `tokenFor`
 * knows which of the two it got.
 */
export interface GithubCredentials {
  readonly method: GithubAuthMethod;
  tokenFor(owner: string, repo: string): Promise<string | null>;
}

/** The one token in `hub.env`, good for whatever the owner scoped it to. */
export class PatCredentials implements GithubCredentials {
  readonly method = 'token' as const;

  constructor(private readonly token: string) {}

  async tokenFor(): Promise<string | null> {
    return this.token;
  }
}

export interface GithubOptions {
  /** Absent means the hub has no GitHub credential at all: public clones only, no pushes, no PRs. */
  credentials?: GithubCredentials;
  /**
   * Test seam: clone `<cloneBase>/<owner>/<repo>.git` instead of the public host, so a bare repo on
   * disk can stand in for GitHub. Unset — which is every deployment — only github.com is reachable.
   */
  cloneBase?: string;
  /** Test seam for the REST calls; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  apiBase?: string;
}

/** What went wrong, classified enough for a route to pick a status code. */
export type GithubErrorCode = 'auth' | 'clone' | 'push' | 'api' | 'config';

export class GithubError extends Error {
  constructor(message: string, readonly code: GithubErrorCode, readonly status?: number) {
    super(message);
    this.name = 'GithubError';
  }
}

/**
 * A branch name safe to hand to git as a value. Conservative on purpose: the owner types this, it
 * reaches `--branch <value>`, and a name starting with a dash would read as an option.
 */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function validBranch(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.includes('..') && !branch.endsWith('.lock') && !branch.endsWith('/');
}

/** The branch agents push to for a project. Never the repository's own branch — see `assertPushable`. */
export const pushBranchFor = (slug: string): string => `agenthub/${slug}`;

/**
 * The guardrail, stated once and asserted at every write: the hub pushes its own branch and nothing
 * else. A project whose `pushBranch` somehow equals the repository's branch is refused rather than
 * pushed, because that push would rewrite the owner's trunk.
 */
export function assertPushable(source: ProjectSource): void {
  if (source.pushBranch === source.branch) {
    throw new GithubError(
      `refusing to push: ${source.pushBranch} is the repository's own branch`, 'config',
    );
  }
}

/** Everything git said, as one string. */
const gitOutput = (err: unknown): string => (err instanceof Error ? (err.message || String(err)) : String(err));

/**
 * The one line of git's complaint worth showing. Not literally the first: git opens with progress
 * ("Cloning into '…'") and puts the reason last, so the `fatal:`/`error:`/`remote:` line wins and
 * the tail is the fallback.
 */
function firstLine(err: unknown): string {
  const lines = gitOutput(err).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error|remote):/i.test(l)) ?? lines[lines.length - 1] ?? 'git failed';
}

/**
 * Whether git failed because it had no usable credential. GitHub answers an unauthenticated request
 * for a private repository with a 404, so "not found" counts: from outside, a private repository and
 * a missing one are the same answer.
 */
const AUTH_HINTS = [
  'could not read username', 'could not read password', 'terminal prompts disabled',
  'authentication failed', 'invalid username or password', 'repository not found',
  'permission denied', 'access denied', 'not found',
];

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_HINTS.some((hint) => lower.includes(hint));
}

/**
 * The identity the hub commits a milestone's work under. The clone is the owner's repository, so
 * nothing is written into its `.git/config`; these travel per invocation instead.
 */
const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: 'AgentHub Bot',
  GIT_AUTHOR_EMAIL: 'agent@agenthub.local',
  GIT_COMMITTER_NAME: 'AgentHub Bot',
  GIT_COMMITTER_EMAIL: 'agent@agenthub.local',
};

/** Non-`GIT_*` variables that still tell git which program to run; dropped along with the `GIT_*` ones. */
const GIT_CONFIGURING_ENV = new Set(['EDITOR', 'VISUAL', 'PAGER', 'SSH_ASKPASS', 'PREFIX']);

/**
 * simple-git refuses `GIT_CONFIG_COUNT` by default, because an *inherited* one lets someone else's
 * environment configure git. Here it is the opposite: the whole inherited git environment is
 * stripped above and this is the only config git sees, which is exactly how the token stays out of
 * `.git/config` and out of the command line (0028).
 */
const UNSAFE_ALLOWED = { allowUnsafeConfigEnvCount: true } as const;

export class Github {
  private readonly credentials: GithubCredentials | undefined;
  private readonly cloneBase: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubOptions = {}) {
    this.credentials = opts.credentials;
    this.cloneBase = opts.cloneBase ?? GITHUB_CLONE_BASE;
    this.apiBase = opts.apiBase ?? GITHUB_API_BASE;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** What `GET /api/github/status` answers: whether a private repository can be reached at all. */
  status(): { configured: boolean; method: GithubAuthMethod } {
    return this.credentials
      ? { configured: true, method: this.credentials.method }
      : { configured: false, method: 'none' };
  }

  private remote(ref: GithubRepoRef): string {
    return `${this.cloneBase}/${ref.owner}/${ref.repo}.git`;
  }

  /**
   * Git's environment for one invocation against `ref`.
   *
   * The token travels as an `http.extraHeader` set through `GIT_CONFIG_*` rather than embedded in
   * the remote URL or passed as `-c`: a URL credential is persisted into the clone's `.git/config`
   * (inside the project workspace agents can read), and `-c` puts the secret in the process's
   * command line, which any user on the box can read. Per-invocation config from the environment is
   * neither persisted nor listed by `ps` (0028).
   */
  private async gitEnv(ref: GithubRepoRef): Promise<Record<string, string>> {
    // Everything the process has *except* anything that configures git. `GIT_DIR`/`GIT_WORK_TREE`
    // would silently redirect these commands at whatever repository the hub was started from, and
    // `EDITOR`/`GIT_ASKPASS`/`PAGER` can name a program git would then run. Nothing about how git
    // behaves here is inherited; it is all set below.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && !key.startsWith('GIT_') && !GIT_CONFIGURING_ENV.has(key.toUpperCase()),
      ),
    ) as Record<string, string>;
    const env: Record<string, string> = {
      ...inherited,
      ...COMMITTER_ENV,
      // Never sit waiting for a username on a repository we cannot see: fail, and say so.
      GIT_TERMINAL_PROMPT: '0',
    };
    const token = await this.credentials?.tokenFor(ref.owner, ref.repo);
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }

  private async git(ref: GithubRepoRef, cwd?: string): Promise<SimpleGit> {
    return simpleGit({ ...(cwd ? { baseDir: cwd } : {}), unsafe: { ...UNSAFE_ALLOWED } })
      .env(await this.gitEnv(ref));
  }

  /**
   * Clones `ref` into `into` (the project's `workspace/`, which must be empty) and reports the
   * branch that landed and its commit. Full history: the agents work in this checkout and the owner
   * merges what comes out of it, so a shallow clone would only have to be deepened later.
   */
  async clone(ref: GithubRepoRef, branch: string | undefined, into: string): Promise<{ branch: string; commit: string }> {
    if (branch !== undefined && !validBranch(branch)) throw new GithubError(`invalid branch: ${branch}`, 'config');
    const git = await this.git(ref);
    try {
      await git.clone(this.remote(ref), into, branch ? ['--branch', branch] : []);
    } catch (err) {
      const line = firstLine(err);
      // Classified on everything git said, not just the line shown: the reason can arrive as a
      // `remote:` line above the `fatal:` one.
      if (isAuthFailure(gitOutput(err))) {
        throw new GithubError(
          this.credentials
            ? `could not read ${ref.owner}/${ref.repo}: ${line}`
            : 'private repository: set GITHUB_TOKEN on the hub',
          'auth',
        );
      }
      throw new GithubError(line, 'clone');
    }
    // The branch is read back from the clone rather than from `ls-remote --symref`, so it is the
    // branch actually checked out rather than the one the remote advertised a moment earlier.
    const clone = simpleGit(into);
    return {
      branch: (await clone.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
      commit: (await clone.raw(['rev-parse', 'HEAD'])).trim(),
    };
  }

  /**
   * Commits whatever the milestone left in the workspace and pushes it to `source.pushBranch`.
   * Returns false when there was nothing to commit and nothing new to push.
   *
   * The push is an ordinary one — the branch is the hub's, so a normal push is the honest default —
   * and only falls back to `--force-with-lease` when the remote's copy has diverged, which for a
   * branch nobody else writes means a previous push we lost track of.
   */
  async pushWorkspace(workspace: string, source: ProjectSource, message: string): Promise<boolean> {
    assertPushable(source);
    if (!this.credentials) throw new GithubError('no GitHub token configured on the hub', 'config');
    const git = await this.git(source, workspace);
    try {
      await git.add(['-A']);
      const status = await git.status();
      if (status.staged.length > 0) await git.commit(message);
      const spec = `HEAD:refs/heads/${source.pushBranch}`;
      try {
        await git.push(['origin', spec]);
      } catch (err) {
        const line = firstLine(err);
        if (!/non-fast-forward|fetch first|rejected/i.test(line)) throw err;
        await git.push(['--force-with-lease', 'origin', spec]);
      }
      return true;
    } catch (err) {
      throw new GithubError(firstLine(err), 'push');
    }
  }

  /**
   * The pull request for `source.pushBranch`, opened if there isn't one already. Idempotent: the
   * owner may press the button again after a later milestone, and GitHub only allows one open pull
   * request per head anyway.
   */
  async openPullRequest(source: ProjectSource, pr: { title: string; body: string }): Promise<string> {
    assertPushable(source);
    const token = await this.credentials?.tokenFor(source.owner, source.repo);
    if (!token) throw new GithubError('no GitHub token configured on the hub', 'config');
    const base = `${this.apiBase}/repos/${source.owner}/${source.repo}/pulls`;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'AgentHub',
      'content-type': 'application/json',
    };

    const head = `${source.owner}:${source.pushBranch}`;
    const existing = await this.call(`${base}?head=${encodeURIComponent(head)}&state=open`, { headers });
    if (Array.isArray(existing) && existing.length > 0) {
      const url = (existing[0] as { html_url?: unknown }).html_url;
      if (typeof url === 'string') return url;
    }

    const created = await this.call(base, {
      method: 'POST', headers,
      body: JSON.stringify({ title: pr.title, body: pr.body, head: source.pushBranch, base: source.branch }),
    });
    const url = (created as { html_url?: unknown } | null)?.html_url;
    if (typeof url !== 'string') throw new GithubError('GitHub did not return a pull request URL', 'api');
    return url;
  }

  /** One REST call, with GitHub's own `message` surfaced instead of a bare status. */
  private async call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new GithubError(`could not reach GitHub: ${firstLine(err)}`, 'api');
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
      throw new GithubError(
        typeof message === 'string' ? message : `GitHub replied ${response.status}`, 'api', response.status,
      );
    }
    return body;
  }
}
