import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, expect, afterAll } from 'vitest';
import { ENROLLMENT_TTL_MS, EnrollmentTokens, hubUrlFrom, installCommand } from '../src/enrollment.js';
import { createHub, type Hub } from '../src/server.js';

const PASSWORD = 'let-me-in';
const DAEMON_TOKEN = 'daemon-token-abc';

const hubs: Hub[] = [];
const spawn = (): Hub => {
  const hub = createHub({ auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' }, staleMs: 60000 });
  hubs.push(hub);
  return hub;
};
afterAll(async () => { for (const hub of hubs) await hub.stop(); });

async function login(hub: Hub): Promise<string> {
  const res = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** Mints through the owner's route, the way the Cluster page does. */
async function mint(hub: Hub, cookie: string, name?: string): Promise<{ token: string; expiresAt: number; command: string }> {
  const res = await hub.app.inject({
    method: 'POST', url: '/api/nodes/enrollment-tokens', headers: { cookie },
    ...(name === undefined ? {} : { payload: { name } }),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const enroll = (hub: Hub, payload: Record<string, unknown>) =>
  hub.app.inject({ method: 'POST', url: '/api/nodes/enroll', payload });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('minting an enrollment token', () => {
  it('returns a 32-hex token, a 24h expiry and the install command, and stores only the hash', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const before = Date.now();
    // The command has to name the hub as the *client* reaches it, so the request's own Host is what
    // decides it — not anything the hub was configured with.
    const res = await hub.app.inject({
      method: 'POST', url: '/api/nodes/enrollment-tokens',
      headers: { cookie, host: 'hub.local:8080' }, payload: { name: 'strix' },
    });
    expect(res.statusCode).toBe(200);
    const minted = res.json() as { token: string; expiresAt: number; command: string };

    expect(minted.token).toMatch(/^[0-9a-f]{32}$/);
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + ENROLLMENT_TTL_MS);
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + ENROLLMENT_TTL_MS);
    expect(minted.command).toBe(`curl -fsSL http://hub.local:8080/install.sh | sh -s -- --hub http://hub.local:8080 --token ${minted.token}`);

    const row = hub.db.prepare(`SELECT * FROM enrollment_tokens`).get() as Record<string, unknown>;
    expect(row.created_by).toBe('admin');
    expect(row.suggested_name).toBe('strix');
    expect(row.used_at).toBeNull();
    // The plaintext is in the reply and nowhere else.
    expect(row.token_hash).not.toBe(minted.token);
    expect(JSON.stringify(row)).not.toContain(minted.token);
  });

  it('is the owner\'s route — no session, no token', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'POST', url: '/api/nodes/enrollment-tokens' });
    expect(res.statusCode).toBe(401);
    // Not even the daemon bearer: minting is not something a node does.
    const asDaemon = await hub.app.inject({ method: 'POST', url: '/api/nodes/enrollment-tokens', headers: bearer(DAEMON_TOKEN) });
    expect(asDaemon.statusCode).toBe(401);
  });
});

describe('enrolling', () => {
  it('trades the token for a per-node bearer and stamps owner, enrolment time and hardware', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);

    const at = Date.now();
    const res = await enroll(hub, { token, name: 'strix', arch: 'x86_64', hardware: { gpu: '7900 XTX', memoryGb: 24 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('strix');
    expect(res.json().nodeToken).toMatch(/^[0-9a-f]{48}$/);

    const node = hub.registry.byName('strix')!;
    expect(node.owner).toBe('admin');
    expect(node.enrolledAt).toBeGreaterThanOrEqual(at);
    expect(node.hardware).toEqual({ gpu: '7900 XTX', memoryGb: 24 });
    // Registration is the daemon's job and hasn't happened yet.
    expect(node.status).toBe('offline');
    // The token hash never reaches the API.
    expect(JSON.stringify(node)).not.toContain(res.json().nodeToken);
    expect(node).not.toHaveProperty('tokenHash');
  });

  it('refuses a second use of the same token', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);

    expect((await enroll(hub, { token, name: 'first', arch: 'x86_64' })).statusCode).toBe(200);
    const again = await enroll(hub, { token, name: 'second', arch: 'x86_64' });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid or expired enrollment token' });
    expect(hub.registry.byName('second')).toBeNull();
  });

  it('refuses an expired token', async () => {
    const hub = spawn();
    // Minted directly against the hub's db so its clock can be pushed into the past; the route
    // itself has no hook for that, and should not grow one.
    const { token } = new EnrollmentTokens(hub.db).mint('admin', undefined, Date.now() - ENROLLMENT_TTL_MS - 1000);
    const res = await enroll(hub, { token, name: 'stale', arch: 'x86_64' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid or expired enrollment token' });
  });

  it('refuses an unknown token, and a malformed body before spending anything', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);

    expect((await enroll(hub, { token: 'f'.repeat(32), name: 'x', arch: 'x86_64' })).statusCode).toBe(401);
    // A bad name is a 400, and leaves the token usable.
    expect((await enroll(hub, { token, name: '../etc', arch: 'x86_64' })).statusCode).toBe(400);
    expect((await enroll(hub, { token, name: 'ok', arch: '' })).statusCode).toBe(400);
    expect((await enroll(hub, { token, name: 'ok', arch: 'x86_64', hardware: 'lots' })).statusCode).toBe(400);
    expect((await enroll(hub, { token, name: 'ok', arch: 'x86_64' })).statusCode).toBe(200);
  });

  it('409s a name another owner already holds, and a synthetic cloud node name', async () => {
    const hub = spawn();
    const cookie = await login(hub);

    const first = await mint(hub, cookie);
    expect((await enroll(hub, { token: first.token, name: 'shared', arch: 'x86_64' })).statusCode).toBe(200);
    // Re-owned by hand: single-user today, so this is the only way to make the two owners differ.
    hub.db.prepare(`UPDATE nodes SET owner='someone-else' WHERE name='shared'`).run();

    const second = await mint(hub, cookie);
    const taken = await enroll(hub, { token: second.token, name: 'shared', arch: 'x86_64' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'name taken' });

    const cloudHub = createHub({
      auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' },
      cloud: { fireworks: { baseUrl: 'http://127.0.0.1:1' } },
    });
    hubs.push(cloudHub);
    const cloudCookie = await login(cloudHub);
    const third = await mint(cloudHub, cloudCookie);
    const reserved = await enroll(cloudHub, { token: third.token, name: 'cloud-fireworks', arch: 'cloud' });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json()).toEqual({ error: 'reserved node name' });
  });

  it('throttles a client that keeps guessing, like login does', async () => {
    const hub = spawn();
    for (let i = 0; i < 5; i += 1) {
      expect((await enroll(hub, { token: 'a'.repeat(32), name: 'n', arch: 'x86_64' })).statusCode).toBe(401);
    }
    const blocked = await enroll(hub, { token: 'a'.repeat(32), name: 'n', arch: 'x86_64' });
    expect(blocked.statusCode).toBe(429);
    // A real token from the same client is refused too, which is what a lockout means.
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);
    expect((await enroll(hub, { token, name: 'n', arch: 'x86_64' })).statusCode).toBe(429);
  });
});

describe('the per-node token', () => {
  /** Enrols `name` and returns its bearer. */
  async function enrolled(hub: Hub, cookie: string, name: string): Promise<string> {
    const { token } = await mint(hub, cookie);
    const res = await enroll(hub, { token, name, arch: 'x86_64' });
    expect(res.statusCode).toBe(200);
    return res.json().nodeToken as string;
  }

  const registration = (name: string) => ({
    name, arch: 'x86_64', jobTypes: ['shell-task'],
    endpoints: [{ tier: 'worker', url: `http://127.0.0.1:81/${name}`, model: 'm', maxStreams: 4 }],
  });

  it('registers, heartbeats and claims for its own node', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const token = await enrolled(hub, cookie, 'strix');

    const reg = await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(token), payload: registration('strix') });
    expect(reg.statusCode).toBe(200);
    expect(hub.registry.byName('strix')?.status).toBe('online');
    // Registration must not lose what enrolment set.
    expect(hub.registry.byName('strix')?.owner).toBe('admin');
    expect(hub.registry.byName('strix')?.enrolledAt).toBeGreaterThan(0);

    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/strix/heartbeat', headers: bearer(token) })).statusCode).toBe(200);

    await hub.app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie },
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    });
    const claim = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', headers: bearer(token), payload: { node: 'strix', types: ['shell-task'] } });
    expect(claim.statusCode).toBe(200);

    // And it may report on the job it is running — including the log route, which names no node.
    const jobId = claim.json().id as number;
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/log`, headers: bearer(token), payload: { line: 'working' } })).statusCode).toBe(200);
    const done = await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/complete`, headers: bearer(token), payload: { node: 'strix', result: { ok: true } } });
    expect(done.statusCode).toBe(200);
  });

  it('is refused (401) the moment it names another node', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const strix = await enrolled(hub, cookie, 'strix');
    const spark = await enrolled(hub, cookie, 'spark');

    await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(spark), payload: registration('spark') });

    // Path parameter.
    const heartbeat = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat', headers: bearer(strix) });
    expect(heartbeat.statusCode).toBe(401);
    expect(heartbeat.json()).toEqual({ error: 'unauthorized' });
    // Body.
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(strix), payload: registration('spark') })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', headers: bearer(strix), payload: { node: 'spark', types: ['shell-task'] } })).statusCode).toBe(401);

    // The job routes: strix may not report on a job spark is running.
    await hub.app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie },
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    });
    const claim = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', headers: bearer(spark), payload: { node: 'spark', types: ['shell-task'] } });
    expect(claim.statusCode).toBe(200);
    const jobId = claim.json().id as number;
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/log`, headers: bearer(strix), payload: { line: 'not mine' } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/complete`, headers: bearer(strix), payload: { node: 'spark', result: {} } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/fail`, headers: bearer(strix), payload: { node: 'spark', error: 'no' } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/artifact?node=spark`, headers: { ...bearer(strix), 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })).statusCode).toBe(401);
    // The job is still spark's to finish.
    expect((await hub.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/complete`, headers: bearer(spark), payload: { node: 'spark', result: {} } })).statusCode).toBe(200);
  });

  it('opens no owner route', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const token = await enrolled(hub, cookie, 'strix');
    for (const url of ['/api/state', '/api/nodes', '/api/projects']) {
      expect((await hub.app.inject({ method: 'GET', url, headers: bearer(token) })).statusCode).toBe(401);
    }
    expect((await hub.app.inject({ method: 'DELETE', url: '/api/nodes/strix', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('is rotated by a re-enrolment from the same owner: the old one stops working', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const first = await enrolled(hub, cookie, 'strix');
    await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(first), payload: registration('strix') });

    const second = await enrolled(hub, cookie, 'strix');
    expect(second).not.toBe(first);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/strix/heartbeat', headers: bearer(first) })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/strix/heartbeat', headers: bearer(second) })).statusCode).toBe(200);
    // A re-install keeps what the node registered about itself.
    expect(hub.registry.byName('strix')?.endpoints).toHaveLength(1);
  });

  it('dies with the node: Remove takes the credential with the row', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const token = await enrolled(hub, cookie, 'strix');
    await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(token), payload: registration('strix') });

    expect((await hub.app.inject({ method: 'DELETE', url: '/api/nodes/strix', headers: { cookie } })).statusCode).toBe(200);

    // Not a 410 (the removal lockout) but a 401: the bearer authenticates as nobody at all now.
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/strix/heartbeat', headers: bearer(token) })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(token), payload: registration('strix') })).statusCode).toBe(401);
  });

  it('lets a removed node be enrolled again straight away, lockout or not', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const token = await enrolled(hub, cookie, 'strix');
    await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(token), payload: registration('strix') });
    await hub.app.inject({ method: 'DELETE', url: '/api/nodes/strix', headers: { cookie } });

    const fresh = await enrolled(hub, cookie, 'strix');
    const reg = await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer(fresh), payload: registration('strix') });
    expect(reg.statusCode).toBe(200);
  });

  it('leaves the shared DAEMON_TOKEN speaking for every node', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    await enrolled(hub, cookie, 'strix');
    const admin = bearer(DAEMON_TOKEN);

    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: admin, payload: registration('strix') })).statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/strix/heartbeat', headers: admin })).statusCode).toBe(200);
    // Including a node that never enrolled at all, which belongs to the admin by default.
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: admin, payload: registration('legacy') })).statusCode).toBe(200);
    expect(hub.registry.byName('legacy')?.owner).toBe('admin');
    expect(hub.registry.byName('legacy')?.enrolledAt).toBeUndefined();
    expect((await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', headers: admin, payload: { node: 'legacy', types: ['shell-task'] } })).statusCode).toBe(204);
  });

  it('is not consulted at all when the hub has no password', async () => {
    const open = createHub({ staleMs: 60000 });
    hubs.push(open);
    const minted = await open.app.inject({ method: 'POST', url: '/api/nodes/enrollment-tokens', payload: { name: 'strix' } });
    expect(minted.statusCode).toBe(200);
    const res = await open.app.inject({ method: 'POST', url: '/api/nodes/enroll', payload: { token: minted.json().token, name: 'strix', arch: 'x86_64' } });
    expect(res.statusCode).toBe(200);
    // Everything stays open, as before.
    expect((await open.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    expect((await open.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat' })).statusCode).toBe(404);
  });
});

describe('hubUrlFrom', () => {
  const req = (origin: string | undefined, protocol = 'http', host = 'hub.local:8080') =>
    ({ headers: origin === undefined ? {} : { origin }, protocol, host });

  it('prefers the client\'s own Origin', () => {
    expect(hubUrlFrom(req('https://hub.rosenroot.com'))).toBe('https://hub.rosenroot.com');
  });

  it('falls back to the request scheme and host', () => {
    expect(hubUrlFrom(req(undefined))).toBe('http://hub.local:8080');
    // What `trustProxy` gives Fastify: the proxy's scheme and forwarded host.
    expect(hubUrlFrom(req(undefined, 'https', 'hub.rosenroot.com'))).toBe('https://hub.rosenroot.com');
  });

  it('ignores an Origin that names no hub', () => {
    expect(hubUrlFrom(req('null'))).toBe('http://hub.local:8080');
    expect(hubUrlFrom(req('https://hub.local/path'))).toBe('http://hub.local:8080');
  });

  it('builds the command the installer is written against', () => {
    expect(installCommand('https://h.example', 'abc')).toBe('curl -fsSL https://h.example/install.sh | sh -s -- --hub https://h.example --token abc');
  });
});

describe('what a joining node downloads', () => {
  const installer = fileURLToPath(new URL('../../../deploy/install.sh', import.meta.url));

  it('serves deploy/install.sh as a shell script', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/install.sh' });
    // The script lands on a parallel branch, so this follows the checkout either way: the 200
    // contract when it is there, the documented 404 until it is.
    if (existsSync(installer)) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/x-shellscript');
      expect(res.body).toBe(readFileSync(installer, 'utf8'));
    } else {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'installer not found' });
    }
  });

  it('is not shadowed by the static UI, which the hub always mounts at /', async () => {
    // Production always passes `uiDist`, and @fastify/static claims `GET /*` — the two installer
    // routes are more specific, so they win, but nothing else in the suite covers them together.
    const dist = await mkdtemp(join(tmpdir(), 'agenthub-ui-'));
    const hub = createHub({ uiDist: dist, staleMs: 60000 });
    hubs.push(hub);
    try {
      await writeFile(join(dist, 'index.html'), '<!doctype html><title>tower</title>');
      expect((await hub.app.inject({ method: 'GET', url: '/' })).body).toContain('<title>tower</title>');

      const script = await hub.app.inject({ method: 'GET', url: '/install.sh' });
      if (existsSync(installer)) {
        expect(script.statusCode).toBe(200);
        expect(script.headers['content-type']).toContain('text/x-shellscript');
      } else {
        // The installer route's own 404, not the static plugin's: proof of which one answered.
        expect(script.json()).toEqual({ error: 'installer not found' });
      }

      // This hub has no auth configured at all, so minting is open too — same as the installer,
      // which has only the enrollment token at this point.
      const minted = await hub.app.inject({ method: 'POST', url: '/api/nodes/enrollment-tokens' });
      const archive = await hub.app.inject({
        method: 'GET', url: `/install/agenthub-src.tgz?token=${(minted.json() as { token: string }).token}`,
      });
      if (archive.statusCode === 200) expect(archive.headers['content-type']).toContain('application/gzip');
      else expect(archive.json()).toEqual({ error: 'not a git checkout' });
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it('needs no session — an installer runs before anyone has logged in', async () => {
    const hub = spawn();
    expect((await hub.app.inject({ method: 'GET', url: '/install.sh' })).statusCode).not.toBe(401);
    // No cookie — but it still needs a credential of its own; see "gating the source tarball"
    // below for what happens with none at all.
    const res = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(DAEMON_TOKEN) });
    expect(res.statusCode).not.toBe(401);
  });

  it('serves a source tarball holding every workspace npm ci will look for', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(DAEMON_TOKEN) });
    // Not a checkout (a released tree, an unpacked tarball) — the route says so and there is
    // nothing to assert about.
    if (res.statusCode === 404) {
      expect(res.json()).toEqual({ error: 'not a git checkout' });
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect(String(res.headers.etag)).toMatch(/^[0-9a-f]{40}$/);

    const dir = await mkdtemp(join(tmpdir(), 'agenthub-src-'));
    try {
      const archive = join(dir, 'src.tgz');
      await writeFile(archive, res.rawPayload);
      const { stdout } = await promisify(execFile)('tar', ['-tzf', archive]);
      const listing = stdout.split('\n');
      // The daemon and everything `npm ci` needs at the archive root to accept the lockfile.
      for (const path of [
        'package.json', 'package-lock.json', 'tsconfig.base.json',
        'packages/node-daemon/package.json', 'packages/shared/package.json',
        'packages/hub/package.json', 'packages/ui/package.json', 'packages/mocks/package.json',
      ]) {
        expect(listing).toContain(path);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds the archive once and keeps it', async () => {
    const hub = spawn();
    const first = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(DAEMON_TOKEN) });
    if (first.statusCode === 404) return;
    const second = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(DAEMON_TOKEN) });
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
  });
});

describe('gating the source tarball', () => {
  it('refuses a request with no credential at all', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'an enrollment token or a node token is required' });
  });

  it('accepts a valid, unused enrollment token — and does not spend it', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);

    const res = await hub.app.inject({ method: 'GET', url: `/install/agenthub-src.tgz?token=${token}` });
    if (res.statusCode !== 404) expect(res.statusCode).toBe(200);

    // Still unused: the installer's real enrollment call right after still spends it.
    expect((await enroll(hub, { token, name: 'strix', arch: 'x86_64' })).statusCode).toBe(200);
  });

  it('refuses a token that has already been used', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);
    expect((await enroll(hub, { token, name: 'strix', arch: 'x86_64' })).statusCode).toBe(200);

    const res = await hub.app.inject({ method: 'GET', url: `/install/agenthub-src.tgz?token=${token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'an enrollment token or a node token is required' });
  });

  it("accepts a node's own bearer, and refuses it once the node is removed", async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const { token } = await mint(hub, cookie);
    const enrollRes = await enroll(hub, { token, name: 'strix', arch: 'x86_64' });
    expect(enrollRes.statusCode).toBe(200);
    const nodeToken = enrollRes.json().nodeToken as string;

    const res = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(nodeToken) });
    if (res.statusCode !== 404) expect(res.statusCode).toBe(200);

    expect((await hub.app.inject({ method: 'DELETE', url: '/api/nodes/strix', headers: { cookie } })).statusCode).toBe(200);
    const after = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(nodeToken) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: 'an enrollment token or a node token is required' });
  });

  it('accepts the admin DAEMON_TOKEN', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/install/agenthub-src.tgz', headers: bearer(DAEMON_TOKEN) });
    if (res.statusCode !== 404) expect(res.statusCode).toBe(200);
  });
});
