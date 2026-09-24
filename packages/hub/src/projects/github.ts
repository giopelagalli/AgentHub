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

/**
 * How the hub found a token, as `GET /api/github/status` reports it. `app` is a GitHub App
 * installation the member connected with a button; `token` is the personal access token in
 * `hub.env`, which stays as the fallback (0033).
 */
export type GithubAuthMethod = 'app' | 'token' | 'none';

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

/**
 * Credentials tried in order, answering with the first that produces a token. This is what "the
 * App, with the personal access token as the fallback" means literally: a member who connected the
 * App still imports a repository the App cannot see if the owner also set `GITHUB_TOKEN` (0033).
 * `method` is the first one's, because that is what the hub is set up with.
 *
 * A link that throws — GitHub unreachable while minting an installation token — is passed over
 * rather than fatal, so one broken credential cannot take out a working one behind it.
 */
export class ChainedCredentials implements GithubCredentials {
  readonly method: GithubAuthMethod;

  constructor(private readonly chain: GithubCredentials[]) {
    this.method = chain[0]?.method ?? 'none';
  }

  async tokenFor(owner: string, repo: string): Promise<string | null> {
    for (const link of this.chain) {
      const token = await link.tokenFor(owner, repo).catch(() => null);
      if (token) return token;
    }
    return null;
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
  /** Test seam: every git invocation's argv, so a test can assert no secret ever reaches it. */
  onGitArgs?: (args: string[]) => void;
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

/** simple-git killed the command because it produced no output for `timeout.block`. */
const isBlockTimeout = (err: unknown): boolean => /block timeout reached/i.test(gitOutput(err));

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
 * simple-git refuses these three by default because they are how *someone else's* environment
 * configures git. Every one of them is used here to take configuration away, not to add it: the
 * whole inherited git environment is stripped first, and what remains is the only config git sees.
 *
 * - `allowUnsafeConfigEnvCount` — `GIT_CONFIG_COUNT`, which carries the token's `http.extraHeader`
 *   and the hooks-path below. It is what keeps the token out of `.git/config` and out of argv.
 * - `allowUnsafeConfigPaths` — `GIT_CONFIG_GLOBAL=/dev/null`, so `~/.gitconfig` cannot inject an
 *   `insteadOf` rewrite, a proxy or a credential helper into a command carrying the token.
 * - `allowUnsafeHooksPath` — `core.hooksPath=/dev/null`, so nothing in the cloned repository's
 *   `.git/hooks` (which agents can write) runs with the token in its environment (0028).
 */
const UNSAFE_ALLOWED = {
  allowUnsafeConfigEnvCount: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeHooksPath: true,
} as const;

/** How long a single git invocation may go without output before it is killed. */
const GIT_BLOCK_TIMEOUT_MS = 120_000;

/**
 * Held out of a milestone's commit. A workspace is where agents wire things up, and a `.env` or a
 * private key they wrote to get something running is not what the owner asked to have pushed to
 * their repository. `:(glob,exclude)**\/x` excludes `x` at any depth, the root included.
 *
 * It is a convention, not a classifier: a secret under another name still goes (see 0030), and a
 * tracked `.env.example` is held back with the rest.
 */
const COMMIT_EXCLUDES = [
  ':(glob,exclude)**/.env*',
  ':(glob,exclude)**/*.pem',
  ':(glob,exclude)**/*.key',
];

export class Github {
  private readonly credentials: GithubCredentials | undefined;
  private readonly cloneBase: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onGitArgs: ((args: string[]) => void) | undefined;

  constructor(opts: GithubOptions = {}) {
    this.credentials = opts.credentials;
    this.cloneBase = opts.cloneBase ?? GITHUB_CLONE_BASE;
    this.apiBase = opts.apiBase ?? GITHUB_API_BASE;
    this.fetchImpl = opts.fetch ?? fetch;
    this.onGitArgs = opts.onGitArgs;
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
   *
   * The header is scoped to `cloneBase` — `http.https://github.com/.extraHeader`, not a bare
   * `http.extraHeader` — because the clone's `origin` URL lives in `workspace/.git/config`, which
   * agents can write. An unscoped header would be sent to whatever host a rewritten remote named.
   * (Pushes name the URL outright for the same reason; see `pushWorkspace`.)
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
      // Neither `/etc/gitconfig` nor `~/.gitconfig` may add an `insteadOf` rewrite, a proxy, a
      // credential helper or a hook template to a command that is carrying the owner's token.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    // `.git/hooks` lives in the workspace, which agents write. A hook fires on commit, on push and
    // on checkout, in this process's environment — so hooks are off for everything this module runs.
    const config: [string, string][] = [['core.hooksPath', '/dev/null']];
    const token = await this.credentials?.tokenFor(ref.owner, ref.repo);
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      config.push([`http.${this.cloneBase}/.extraHeader`, `Authorization: Basic ${basic}`]);
    }
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    return env;
  }

  private async git(ref: GithubRepoRef, cwd?: string): Promise<SimpleGit> {
    const git = simpleGit({
      ...(cwd ? { baseDir: cwd } : {}),
      unsafe: { ...UNSAFE_ALLOWED },
      // A clone that stalls must not hold the creating request open forever.
      timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    }).env(await this.gitEnv(ref));
    // The argv of every command this module runs, for the test that asserts no secret is in it.
    const onArgs = this.onGitArgs;
    return onArgs ? git.outputHandler((_cmd, _out, _err, args) => onArgs(args)) : git;
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
      if (isBlockTimeout(err)) {
        throw new GithubError(
          `${ref.owner}/${ref.repo} stopped responding after ${GIT_BLOCK_TIMEOUT_MS / 1000}s; the clone was abandoned`,
          'clone',
        );
      }
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
   *
   * The destination is the URL this module computes, never the symbolic `origin`: `origin`'s URL
   * lives in `workspace/.git/config`, which agents can write, so pushing to it would let a rewritten
   * remote decide where the owner's code — and the header carrying their token — is sent.
   *
   * The push is an ordinary one and stays one. `agenthub/<slug>` is the hub's own branch, so a
   * diverged remote copy means somebody else rewrote it; that is reported rather than forced over
   * (0030). `--no-verify` and `core.hooksPath` both keep the repository's hooks out of it.
   */
  async pushWorkspace(workspace: string, source: ProjectSource, message: string): Promise<void> {
    assertPushable(source);
    if (!this.credentials) throw new GithubError('no GitHub token configured on the hub', 'config');
    const git = await this.git(source, workspace);
    try {
      // Everything the milestone produced except files that are credentials by convention: an agent
      // that wrote a `.env` while wiring something up must not have it published to the owner's
      // repository by the next verified milestone.
      await git.raw(['add', '-A', '--', '.', ...COMMIT_EXCLUDES]);
      // `status.staged` misses a rename, so what is staged is read from the index itself.
      const staged = (await git.raw(['diff', '--cached', '--name-only'])).trim();
      if (staged) await git.raw(['commit', '--no-verify', '-m', message]);
      await git.raw(['push', '--no-verify', this.remote(source), `HEAD:refs/heads/${source.pushBranch}`]);
    } catch (err) {
      if (isBlockTimeout(err)) {
        throw new GithubError(`${source.owner}/${source.repo} stopped responding; the push was abandoned`, 'push');
      }
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
