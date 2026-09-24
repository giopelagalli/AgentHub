import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretsStripped } from '@agenthub/shared/shell';
import { routeAccess } from '../src/auth.js';
import { openDb } from '../src/db.js';
import {
  AppCredentials, ConnectState, GithubAppClient, appJwt, type GithubAppConfig,
} from '../src/projects/github-app.js';
import { GithubInstallations } from '../src/projects/github-installations.js';
import { ChainedCredentials, Github, PatCredentials } from '../src/projects/github.js';
import { createHub, type Hub } from '../src/server.js';

/**
 * The GitHub App connect flow, against a stubbed GitHub: a fake `fetch` answers the four endpoints
 * the hub uses (the OAuth token exchange, `GET /user`, `GET /user/installations`, the installation
 * token, and the installation's repositories), so the whole round trip — connect, callback, picker,
 * disconnect — runs offline and the credential path can be asserted without a real app.
 */

const API = 'https://api.test';
const WEB = 'https://web.test';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CONFIG: GithubAppConfig = {
  appId: '1234',
  clientId: 'Iv1.test',
  clientSecret: 'shh',
  privateKey: PRIVATE_KEY,
  slug: 'agenthub-test',
};

/** What the stub is currently pretending is true on GitHub's side. */
interface Fake {
  /** Installations the OAuth user owns. */
  installations: { id: number; account: { id: number; login: string; type: string } }[];
  /** Repositories each installation reaches. */
  repos: Record<number, { full_name: string; private: boolean; default_branch: string; updated_at: string }[]>;
  /** Every installation token minted, in order. */
  minted: number[];
  /** Whether the OAuth exchange should fail. */
  badCode?: boolean;
}

let fake: Fake;
let root: string;
let hub: Hub | undefined;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stands in for github.com and api.github.com, in the shape the real ones answer. */
const githubFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${WEB}/login/oauth/access_token`)) {
    // The OAuth endpoint answers 200 with an `error` body, which is why a bad code is not a status.
    return fake.badCode ? json({ error: 'bad_verification_code' }) : json({ access_token: 'ghu_user' });
  }
  if (url === `${API}/user`) return json({ login: fake.installations[0]?.account.login ?? 'nobody' });
  if (url.startsWith(`${API}/user/installations`)) {
    return json({ total_count: fake.installations.length, installations: fake.installations });
  }
  const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
  if (mint) {
    const id = Number(mint[1]);
    fake.minted.push(id);
    return json({ token: `ghs_${id}_${fake.minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (url.startsWith(`${API}/installation/repositories`)) {
    // Which installation is asking is in the bearer, which the mint above made `ghs_<id>_<n>`.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const id = Number(/ghs_(\d+)_/.exec(headers.authorization ?? '')?.[1] ?? 0);
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return json({ repositories: page === 1 ? (fake.repos[id] ?? []) : [] });
  }
  return json({ message: `unexpected ${url}` }, 404);
};

const REPOS = {
  7: [
    { full_name: 'acme/portal', private: true, default_branch: 'main', updated_at: '2026-09-20T10:00:00Z' },
    { full_name: 'acme/site', private: false, default_branch: 'trunk', updated_at: '2026-09-23T10:00:00Z' },
  ],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-github-app-'));
  fake = {
    installations: [{ id: 7, account: { id: 1, login: 'acme', type: 'Organization' } }],
    repos: { ...REPOS },
    minted: [],
  };
});

afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  await rm(root, { recursive: true, force: true });
});

interface HubOver { app?: GithubAppConfig | null; token?: string }

function makeHub(over: HubOver = {}): Hub {
  const { app = CONFIG, token } = over;
  hub = createHub({
    projectsRoot: root,
    github: {
      ...(app ? { app } : {}),
      ...(token ? { token } : {}),
      fetch: githubFetch, apiBase: API, webBase: WEB,
    },
  });
  return hub;
}

/** Presses Connect and hands back the `state` GitHub would have carried. */
async function connectState(): Promise<string> {
  const res = await hub!.app.inject({ method: 'GET', url: '/api/github/connect' });
  expect(res.statusCode).toBe(302);
  const location = res.headers.location as string;
  expect(location.startsWith(`${WEB}/apps/agenthub-test/installations/new`)).toBe(true);
  return new URL(location).searchParams.get('state') as string;
}

/** The callback GitHub would send after an install. */
const callback = (query: Record<string, string>) =>
  hub!.app.inject({ method: 'GET', url: `/api/github/callback?${new URLSearchParams(query)}` });

describe('the app JWT', () => {
  it('is an RS256 token GitHub would accept: header, claims and a signature over both', () => {
    const now = 1_700_000_000_000;
    const token = appJwt(CONFIG, now);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const seconds = Math.floor(now / 1000);
    expect(claims.iss).toBe('1234');
    // Backdated by a minute for clock skew, and well inside GitHub's ten-minute ceiling.
    expect(claims.iat).toBe(seconds - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(seconds);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(PRIVATE_KEY), Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('the connect state', () => {
  it('round-trips the member it was minted for', () => {
    const state = new ConnectState('secret');
    expect(state.verify(state.sign('admin'))).toBe('admin');
  });

  it('refuses a tampered, truncated or forged state', () => {
    const state = new ConnectState('secret');
    const good = state.sign('admin');
    const parts = good.split('.');
    expect(state.verify(`${parts[0]}.${Buffer.from('mallory').toString('base64url')}.${parts[2]}.${parts[3]}`)).toBeNull();
    expect(state.verify(good.slice(0, -2))).toBeNull();
    expect(state.verify(parts.slice(0, 3).join('.'))).toBeNull();
    expect(state.verify(undefined)).toBeNull();
    // A different hub's key never verifies this one's state.
    expect(new ConnectState('other').verify(good)).toBeNull();
  });

  it('expires', () => {
    let now = 1000;
    const state = new ConnectState('secret', () => now);
    const token = state.sign('admin');
    now += 14 * 60 * 1000;
    expect(state.verify(token)).toBe('admin');
    now += 2 * 60 * 1000;
    expect(state.verify(token)).toBeNull();
  });
});

describe('status and the connect route', () => {
  it('reports the app, the install route, and nothing connected yet', async () => {
    makeHub();
    const status = await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json());
    expect(status).toMatchObject({ configured: true, method: 'app', connected: false, installUrl: '/api/github/connect' });
    expect(status.installations).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('shh');
  });

  it('answers `token` with no app, and `none` with neither', async () => {
    makeHub({ app: null, token: 'ghp_test' });
    expect(await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json()))
      .toMatchObject({ configured: true, method: 'token', connected: false });
    await hub!.stop();
    makeHub({ app: null });
    expect(await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json()))
      .toMatchObject({ configured: false, method: 'none', connected: false });
  });

  it('sends the browser to GitHub with a state this hub signed', async () => {
    makeHub();
    const state = await connectState();
    expect(state).toBeTruthy();
    // The state verifies on the way back: the callback accepts it.
    const res = await callback({ state, code: 'abc', installation_id: '7', setup_action: 'install' });
    expect(res.statusCode).toBe(302);
  });

  it('is a 400 when no app is configured', async () => {
    makeHub({ app: null, token: 'ghp_test' });
    expect((await hub!.app.inject({ method: 'GET', url: '/api/github/connect' })).statusCode).toBe(400);
  });
});

describe('the callback', () => {
  it('stores the installation the OAuth user owns and sends the browser home', async () => {
    makeHub();
    const state = await connectState();
    const res = await callback({ state, code: 'abc', installation_id: '7', setup_action: 'install' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?github=connected');
    const status = await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json());
    expect(status.connected).toBe(true);
    expect(status.installations).toEqual([
      { id: 7, login: 'acme', type: 'Organization', manageUrl: `${WEB}/settings/installations/7` },
    ]);
  });

  it('refuses an installation the OAuth user does not own', async () => {
    makeHub();
    const state = await connectState();
    // GitHub warns the id on this URL can be spoofed; `GET /user/installations` is the check.
    const res = await callback({ state, code: 'abc', installation_id: '999', setup_action: 'install' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not belong/);
    expect((await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json())).connected).toBe(false);
  });

  it('refuses a tampered or expired state, and a callback with no code', async () => {
    makeHub();
    const state = await connectState();
    const tampered = `${state.slice(0, -1)}${state.endsWith('0') ? '1' : '0'}`;
    expect((await callback({ state: tampered, code: 'abc', installation_id: '7' })).statusCode).toBe(400);
    expect((await callback({ state: 'nonsense', code: 'abc', installation_id: '7' })).statusCode).toBe(400);
    expect((await callback({ state, installation_id: '7' })).statusCode).toBe(400);
    expect((await callback({ state, code: 'abc' })).statusCode).toBe(400);
  });

  it('accepts a callback with no state at all — GitHub omits it on a later update', async () => {
    makeHub();
    const res = await callback({ code: 'abc', installation_id: '7', setup_action: 'update' });
    expect(res.statusCode).toBe(302);
    expect((await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json())).connected).toBe(true);
  });

  it('surfaces a refused sign-in as a 502 rather than storing anything', async () => {
    makeHub();
    fake.badCode = true;
    const res = await callback({ code: 'stale', installation_id: '7' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/bad_verification_code/);
  });
});

describe('the repository picker', () => {
  it('is empty until something is connected, then newest first', async () => {
    makeHub();
    expect(await hub!.app.inject({ method: 'GET', url: '/api/github/repos' }).then((r) => r.json())).toEqual([]);
    await callback({ code: 'abc', installation_id: '7' });
    const repos = await hub!.app.inject({ method: 'GET', url: '/api/github/repos' }).then((r) => r.json());
    expect(repos).toEqual([
      { fullName: 'acme/site', private: false, defaultBranch: 'trunk', updatedAt: '2026-09-23T10:00:00Z' },
      { fullName: 'acme/portal', private: true, defaultBranch: 'main', updatedAt: '2026-09-20T10:00:00Z' },
    ]);
  });
});

describe('disconnecting', () => {
  it('forgets the installation, and says so in the status', async () => {
    makeHub();
    await callback({ code: 'abc', installation_id: '7' });
    const res = await hub!.app.inject({ method: 'DELETE', url: '/api/github/installations/7' });
    expect(res.statusCode).toBe(200);
    expect((await hub!.app.inject({ method: 'GET', url: '/api/github/status' }).then((r) => r.json())).connected).toBe(false);
    // Gone is gone: a second press is a 404, not a silent success.
    expect((await hub!.app.inject({ method: 'DELETE', url: '/api/github/installations/7' })).statusCode).toBe(404);
    expect((await hub!.app.inject({ method: 'DELETE', url: '/api/github/installations/zero' })).statusCode).toBe(400);
  });
});

describe('AppCredentials', () => {
  const credentials = (now: () => number = Date.now) => {
    const db = openDb(':memory:');
    const installations = new GithubInstallations(db);
    installations.upsert({ installationId: 7, user: 'admin', accountLogin: 'acme', accountType: 'Organization' });
    const client = new GithubAppClient({ config: CONFIG, fetch: githubFetch, apiBase: API, webBase: WEB, now });
    return new AppCredentials(client, installations, 'admin', now);
  };

  it('mints a token for the installation whose account owns the repo, and caches it', async () => {
    const creds = credentials();
    expect(await creds.tokenFor('acme', 'portal')).toBe('ghs_7_1');
    expect(await creds.tokenFor('acme', 'site')).toBe('ghs_7_1');
    expect(fake.minted).toEqual([7]);
  });

  it('mints again once the cached token is close to expiring', async () => {
    let now = Date.now();
    const creds = credentials(() => now);
    expect(await creds.tokenFor('acme', 'portal')).toBe('ghs_7_1');
    now += 56 * 60 * 1000;
    expect(await creds.tokenFor('acme', 'portal')).toBe('ghs_7_2');
    expect(fake.minted).toEqual([7, 7]);
  });

  it('falls back to the installation that lists the repository when no account matches', async () => {
    fake.installations = [{ id: 7, account: { id: 1, login: 'acme', type: 'Organization' } }];
    fake.repos[7] = [{ full_name: 'other/thing', private: false, default_branch: 'main', updated_at: '' }];
    const creds = credentials();
    expect(await creds.tokenFor('other', 'thing')).toBe('ghs_7_1');
    expect(await creds.tokenFor('nobody', 'nothing')).toBeNull();
  });
});

describe('credential precedence', () => {
  const owner = { owner: 'acme', repo: 'portal' };

  it('is the app first, the personal access token second, and none last', async () => {
    const db = openDb(':memory:');
    const installations = new GithubInstallations(db);
    installations.upsert({ installationId: 7, user: 'admin', accountLogin: 'acme', accountType: 'Organization' });
    const app = new AppCredentials(
      new GithubAppClient({ config: CONFIG, fetch: githubFetch, apiBase: API, webBase: WEB }), installations, 'admin',
    );
    const pat = new PatCredentials('ghp_test');

    const both = new ChainedCredentials([app, pat]);
    expect(both.method).toBe('app');
    expect(await both.tokenFor(owner.owner, owner.repo)).toBe('ghs_7_1');
    // A repository no installation covers falls through to the token rather than failing.
    expect(await both.tokenFor('someone', 'else')).toBe('ghp_test');

    expect(new ChainedCredentials([pat]).method).toBe('token');
    expect(new Github({ credentials: new ChainedCredentials([pat]) }).status())
      .toEqual({ configured: true, method: 'token' });
    expect(new Github().status()).toEqual({ configured: false, method: 'none' });
  });
});

describe('the app secrets', () => {
  it('are stripped from every command an agent runs, by the GITHUB_APP_ prefix', () => {
    const env = {
      GITHUB_APP_ID: '1234', GITHUB_APP_CLIENT_SECRET: 'shh', GITHUB_APP_PRIVATE_KEY: '/etc/key.pem',
      GITHUB_TOKEN: 'ghp_x', PATH: '/usr/bin',
    };
    const stripped = secretsStripped(env);
    expect(Object.keys(stripped)).toEqual(['PATH']);
  });
});

describe('route access', () => {
  it('keeps every GitHub route behind the owner session', () => {
    for (const [method, route] of [
      ['GET', '/api/github/status'],
      ['GET', '/api/github/connect'],
      ['GET', '/api/github/callback'],
      ['GET', '/api/github/repos'],
      ['DELETE', '/api/github/installations/:id'],
    ] as const) {
      expect(routeAccess(method, route)).toBe('owner');
    }
  });
});
