import { connect } from 'node:net';
import { describe, it, expect, afterAll } from 'vitest';
import { routeAccess, safeEqual, SESSION_COOKIE } from '../src/auth.js';
import { createHub, type Hub } from '../src/server.js';

const PASSWORD = 'let-me-in';
const DAEMON_TOKEN = 'daemon-token-abc';

const hubs: Hub[] = [];
const spawn = (): Hub => {
  const hub = createHub({ auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' } });
  hubs.push(hub);
  return hub;
};
afterAll(async () => { for (const hub of hubs) await hub.stop(); });

/** Logs in and returns the `hub_session=<token>` pair to send back as a Cookie header. */
async function login(hub: Hub, password = PASSWORD): Promise<string> {
  const res = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/**
 * A real `/ws` handshake over a raw socket — the HTTP client would hide the distinction this test
 * is about. Resolves the status line the hub answered with.
 */
function handshake(port: number, cookie?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /ws HTTP/1.1', 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(cookie ? [`Cookie: ${cookie}`] : []), '', '',
      ].join('\r\n'));
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += String(chunk);
      const end = buf.indexOf('\r\n');
      if (end < 0) return;
      socket.destroy();
      resolve(buf.slice(0, end));
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('handshake timed out')); });
  });
}

describe('auth policy', () => {
  it('guards /api and /ws, leaves the static ui and the two exceptions alone', () => {
    expect(routeAccess('GET', '/')).toBe('none');
    expect(routeAccess('GET', '/assets/tower.js')).toBe('none');
    expect(routeAccess('GET', '/api/health')).toBe('open');
    expect(routeAccess('POST', '/api/login')).toBe('open');
    expect(routeAccess('GET', '/ws')).toBe('owner');
    expect(routeAccess('GET', '/api/state')).toBe('owner');
    expect(routeAccess('POST', '/api/projects')).toBe('owner');
    // A login route is only open for the login itself.
    expect(routeAccess('GET', '/api/login')).toBe('owner');
  });

  it('lets the daemon token reach node, job-report and browser-relay routes only', () => {
    expect(routeAccess('POST', '/api/nodes/register')).toBe('daemon');
    expect(routeAccess('POST', '/api/nodes/spark/heartbeat')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/claim')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/7/log')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/7/complete')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/7/fail')).toBe('daemon');
    expect(routeAccess('POST', '/api/browser/act')).toBe('daemon');
    // Enqueuing and reading jobs is the owner's, not a runner's.
    expect(routeAccess('POST', '/api/jobs')).toBe('owner');
    expect(routeAccess('GET', '/api/jobs/7')).toBe('owner');
    expect(routeAccess('POST', '/api/browser/lease')).toBe('owner');
  });

  it('compares in constant time without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', 'a-much-longer-password')).toBe(false);
  });
});

describe('hub auth', () => {
  it('leaves every route open when no auth is configured', async () => {
    const open = createHub();
    hubs.push(open);
    expect((await open.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    expect((await open.app.inject({ method: 'GET', url: '/api/me' })).json()).toEqual({ owner: true });
    expect((await open.app.inject({ method: 'POST', url: '/api/nodes/register', payload: { name: 'n', arch: 'x64', endpoints: [] } })).statusCode).toBe(200);
  });

  it('401s an owner route without a session and serves it with one', async () => {
    const hub = spawn();
    const denied = await hub.app.inject({ method: 'GET', url: '/api/state' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'unauthorized' });
    expect((await hub.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);

    const cookie = await login(hub);
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: { cookie } })).statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json()).toEqual({ owner: true });
  });

  it('refuses a wrong, missing or malformed password without issuing a cookie', async () => {
    const hub = spawn();
    for (const payload of [{ password: 'nope' }, {}, { password: 42 }]) {
      const res = await hub.app.inject({ method: 'POST', url: '/api/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('issues an HttpOnly, SameSite=Lax, 30-day cookie, Secure only behind TLS', async () => {
    const hub = spawn();
    const plain = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    const header = String(plain.headers['set-cookie']);
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=2592000');
    expect(header).not.toContain('Secure');

    const proxied = await hub.app.inject({
      method: 'POST', url: '/api/login',
      headers: { 'x-forwarded-proto': 'https' }, payload: { password: PASSWORD },
    });
    expect(String(proxied.headers['set-cookie'])).toContain('Secure');
  });

  it('rejects a forged or tampered session token', async () => {
    const hub = spawn();
    const forged = `${SESSION_COOKIE}=${Date.now() + 60_000}.${'0'.repeat(64)}`;
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: { cookie: forged } })).statusCode).toBe(401);
    const expired = `${SESSION_COOKIE}=1.deadbeef`;
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: { cookie: expired } })).statusCode).toBe(401);
  });

  it('clears the cookie on logout', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const res = await hub.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('answers the health probe with no credentials at all', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('takes the daemon bearer on daemon routes, and nothing else on owner routes', async () => {
    const hub = spawn();
    const bearer = { authorization: `Bearer ${DAEMON_TOKEN}` };
    const registration = { name: 'spark', arch: 'x64', endpoints: [], jobTypes: ['shell-task'] };

    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', payload: registration })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: { authorization: 'Bearer wrong' }, payload: registration })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/register', headers: bearer, payload: registration })).statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat', headers: bearer })).statusCode).toBe(200);
    const claim = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', headers: bearer, payload: { node: 'spark', types: ['shell-task'] } });
    expect(claim.statusCode).toBe(204);

    // The token is a daemon's credential, not a session: it opens nothing else.
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: '/api/jobs', headers: bearer, payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} } })).statusCode).toBe(401);
  });

  it('also lets the owner session drive the daemon routes', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const res = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register', headers: { cookie },
      payload: { name: 'macmini', arch: 'arm64', endpoints: [] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses the websocket upgrade without a session and completes it with one', async () => {
    const hub = spawn();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;

    expect(await handshake(port)).toContain('401 Unauthorized');
    expect(await handshake(port, await login(hub))).toContain('101 Switching Protocols');
  });
});
