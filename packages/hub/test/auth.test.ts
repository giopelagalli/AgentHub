import { connect } from 'node:net';
import { describe, it, expect, afterAll } from 'vitest';
import { daemonRouteSubject, originOf, routeAccess, safeEqual, sameOriginWrite, SESSION_COOKIE } from '../src/auth.js';
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
function handshake(port: number, cookie?: string, path = '/ws'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
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
    expect(routeAccess('HEAD', '/api/health')).toBe('open');
    expect(routeAccess('POST', '/api/login')).toBe('open');
    expect(routeAccess('GET', '/ws')).toBe('owner');
    expect(routeAccess('GET', '/api/state')).toBe('assistant');
    expect(routeAccess('POST', '/api/projects')).toBe('assistant');
    // A login route is only open for the login itself.
    expect(routeAccess('GET', '/api/login')).toBe('owner');
    // No route matched, or a route nobody has classified: denied by default.
    expect(routeAccess('GET', undefined)).toBe('owner');
  });

  it('opens exactly the allow-listed project routes to the assistant scope', () => {
    for (const [method, route] of [
      ['GET', '/api/state'], ['GET', '/api/briefings'], ['GET', '/api/projects'], ['GET', '/api/projects/:slug/turns'],
      ['POST', '/api/projects'], ['POST', '/api/projects/:slug/prd/draft'], ['POST', '/api/projects/:slug/roadmap/generate'],
      ['POST', '/api/projects/:slug/turn'], ['POST', '/api/projects/:slug/pause'], ['POST', '/api/projects/:slug/resume'],
      ['POST', '/api/projects/:slug/priority'],
    ] as const) expect(routeAccess(method, route), `${method} ${route}`).toBe('assistant');
    for (const [method, route] of [
      ['GET', '/api/tokens'], ['POST', '/api/tokens'], ['POST', '/api/nodes/enrollment-tokens'],
      ['GET', '/api/projects/:slug/terminal'], ['PUT', '/api/projects/:slug/code/file'], ['POST', '/api/projects/:slug/media'],
      ['POST', '/api/projects/:slug/archive'], ['PUT', '/api/projects/:slug/prd'], ['GET', '/api/projects/:slug'],
      ['POST', '/api/projects/:slug/autorun'], ['POST', '/api/projects/:slug/harness'], ['DELETE', '/api/projects'],
    ] as const) expect(routeAccess(method, route), `${method} ${route}`).toBe('owner');
  });

  it('opens enrolment and the installer, which run before anyone can have a session', () => {
    expect(routeAccess('POST', '/api/nodes/enroll')).toBe('open');
    // Outside /api/, so unguarded like the static UI.
    expect(routeAccess('GET', '/install.sh')).toBe('none');
    expect(routeAccess('GET', '/install/agenthub-src.tgz')).toBe('none');
    // Minting one is the owner's, and it is not something a daemon bearer may do either.
    expect(routeAccess('POST', '/api/nodes/enrollment-tokens')).toBe('owner');
  });

  it('says where every daemon route names the node it speaks for', () => {
    expect(daemonRouteSubject('POST', '/api/nodes/register')).toEqual({ from: 'body', key: 'name' });
    expect(daemonRouteSubject('POST', '/api/nodes/:name/heartbeat')).toEqual({ from: 'param', key: 'name' });
    expect(daemonRouteSubject('POST', '/api/jobs/claim')).toEqual({ from: 'body', key: 'node' });
    expect(daemonRouteSubject('POST', '/api/jobs/:id/complete')).toEqual({ from: 'body', key: 'node' });
    expect(daemonRouteSubject('POST', '/api/jobs/:id/fail')).toEqual({ from: 'body', key: 'node' });
    expect(daemonRouteSubject('POST', '/api/jobs/:id/artifact')).toEqual({ from: 'query', key: 'node' });
    // The one route that names no node: its subject is the job's runner of record.
    expect(daemonRouteSubject('POST', '/api/jobs/:id/log')).toEqual({ from: 'job', key: 'id' });
    // Not a daemon route, so no subject — and no per-node token can reach it.
    expect(daemonRouteSubject('GET', '/api/state')).toBeUndefined();
    expect(daemonRouteSubject('GET', undefined)).toBeUndefined();
  });

  it('lets the daemon token reach node-registration and job-report routes only', () => {
    expect(routeAccess('POST', '/api/nodes/register')).toBe('daemon');
    expect(routeAccess('POST', '/api/nodes/:name/heartbeat')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/claim')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/:id/log')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/:id/complete')).toBe('daemon');
    expect(routeAccess('POST', '/api/jobs/:id/fail')).toBe('daemon');
    // Enqueuing and reading jobs is the owner's, not a runner's; so is the node list, and so is the
    // browser relay — a leaked daemon token must not be able to drive the owner's browser.
    expect(routeAccess('POST', '/api/jobs')).toBe('owner');
    expect(routeAccess('GET', '/api/jobs/:id')).toBe('owner');
    expect(routeAccess('POST', '/api/browser/lease')).toBe('owner');
    expect(routeAccess('POST', '/api/browser/act')).toBe('owner');
    expect(routeAccess('GET', '/api/nodes')).toBe('owner');
    // Draining and removing a node is the owner's call, not a daemon's.
    expect(routeAccess('POST', '/api/nodes/:name/drain')).toBe('owner');
    expect(routeAccess('POST', '/api/nodes/:name/models')).toBe('owner');
    expect(routeAccess('DELETE', '/api/nodes/:name')).toBe('owner');
  });

  it('compares in constant time without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', 'a-much-longer-password')).toBe(false);
  });
});

describe('sameOriginWrite', () => {
  const self = 'http://hub.local:4000';

  it('lets a read through however it was reached', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(sameOriginWrite(method, { 'sec-fetch-site': 'cross-site', origin: 'http://evil' }, self)).toBe(true);
    }
  });

  it('takes Sec-Fetch-Site as the answer when the browser sent one', () => {
    expect(sameOriginWrite('POST', { 'sec-fetch-site': 'same-origin' }, self)).toBe(true);
    // Same *site*, different port — which is exactly what the preview listener is.
    expect(sameOriginWrite('POST', { 'sec-fetch-site': 'same-site' }, self)).toBe(false);
    expect(sameOriginWrite('POST', { 'sec-fetch-site': 'cross-site' }, self)).toBe(false);
    expect(sameOriginWrite('POST', { 'sec-fetch-site': 'none' }, self)).toBe(false);
  });

  it('falls back to Origin, and lets a request with neither header through', () => {
    expect(sameOriginWrite('POST', { origin: self }, self)).toBe(true);
    expect(sameOriginWrite('POST', { origin: 'http://hub.local:4010' }, self)).toBe(false);
    expect(sameOriginWrite('POST', { origin: 'http://evil.example' }, self)).toBe(false);
    // curl, a script, a test: not a browser acting for a page, which is the attack.
    expect(sameOriginWrite('POST', {}, self)).toBe(true);
  });

  it('writes the origin the way a browser would', () => {
    expect(originOf('hub.local:4000', false)).toBe('http://hub.local:4000');
    expect(originOf('hub.example.com', true)).toBe('https://hub.example.com');
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

  it('refuses a cookie-authenticated write that came from another origin', async () => {
    const hub = spawn();
    const cookie = await login(hub);
    const write = (headers: Record<string, string>) => hub.app.inject({
      method: 'POST', url: '/api/projects/ghost/pause', headers: { cookie, host: 'hub.local:4000', ...headers },
    });

    // The preview listener is another *port* on the same site, so a Lax cookie rides along; this
    // is the check that stops project code posting to the hub as the owner.
    const refused = await write({ origin: 'http://hub.local:4010' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'cross-origin request refused' });
    expect((await write({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);

    // The hub's own page gets through — to the route's own 404 for a project that isn't there.
    expect((await write({ origin: 'http://hub.local:4000' })).statusCode).toBe(404);
    expect((await write({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(404);
    // A read from anywhere is still a read.
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: { cookie, origin: 'http://evil' } })).statusCode).toBe(200);
  });

  it('exempts a bearer-carrying write, which no browser sends by itself', async () => {
    const hub = spawn();
    const registered = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      headers: { authorization: `Bearer ${DAEMON_TOKEN}`, origin: 'http://evil.example' },
      payload: { name: 'spark', arch: 'arm64', endpoints: [] },
    });
    expect(registered.statusCode).toBe(200);
  });

  it('lets the owner log in from a page it has not served yet', async () => {
    const hub = spawn();
    const res = await hub.app.inject({
      method: 'POST', url: '/api/login', payload: { password: PASSWORD }, headers: { origin: 'null' },
    });
    expect(res.statusCode).toBe(200);
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
    // The router percent-decodes before it matches, so an encoded path is the same route.
    expect(await handshake(port, undefined, '/%77s')).toContain('401 Unauthorized');
    expect(await handshake(port, await login(hub))).toContain('101 Switching Protocols');
  });

  it('guards a percent-encoded path the same as the plain one', async () => {
    const hub = spawn();
    for (const url of ['/%61pi/state', '/api/%73tate', '/%61pi/nodes']) {
      expect((await hub.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    // The encoding is not what is refused: the same path with a session is served.
    const cookie = await login(hub);
    expect((await hub.app.inject({ method: 'GET', url: '/%61pi/state', headers: { cookie } })).statusCode).toBe(200);
  });

  it('refuses a traversal path outright', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/api/nodes/../state' });
    expect([400, 401]).toContain(res.statusCode);
  });

  it('401s rather than 500s on a cookie value that is not valid encoding', async () => {
    const hub = spawn();
    const res = await hub.app.inject({ method: 'GET', url: '/api/state', headers: { cookie: `${SESSION_COOKIE}=%` } });
    expect(res.statusCode).toBe(401);
  });

  it('keeps the browser relay and the node list off the daemon token', async () => {
    const hub = spawn();
    const bearer = { authorization: `Bearer ${DAEMON_TOKEN}` };
    expect((await hub.app.inject({ method: 'POST', url: '/api/browser/act', headers: bearer, payload: {} })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'GET', url: '/api/nodes', headers: bearer })).statusCode).toBe(401);

    // The owner reaches both: a 400 here is the handler refusing an empty action, not the hook.
    const cookie = await login(hub);
    expect((await hub.app.inject({ method: 'POST', url: '/api/browser/act', headers: { cookie }, payload: {} })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } })).statusCode).toBe(200);
  });

  it('answers a HEAD health probe too', async () => {
    const hub = spawn();
    expect((await hub.app.inject({ method: 'HEAD', url: '/api/health' })).statusCode).toBe(200);
  });

  it('locks a client out after five failed logins and lets it back in after the window', async () => {
    let now = Date.now();
    const hub = createHub({ auth: { password: PASSWORD, sessionSecret: 'test-secret', now: () => now } });
    hubs.push(hub);
    const attempt = (password: string, remoteAddress = '10.0.0.9') =>
      hub.app.inject({ method: 'POST', url: '/api/login', payload: { password }, remoteAddress });

    for (let i = 0; i < 5; i += 1) expect((await attempt('nope')).statusCode).toBe(401);
    // Even the right password waits out the lockout.
    expect((await attempt(PASSWORD)).statusCode).toBe(429);
    // One client's failures are not another's.
    expect((await attempt(PASSWORD, '10.0.0.10')).statusCode).toBe(200);

    now += 15 * 60 * 1000 + 1;
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
  });

  it('keys the throttle on the forwarded client only when a proxy is trusted', async () => {
    // Behind Caddy every login arrives from the proxy's address, so without trustProxy one
    // attacker's five failures would lock the owner out too. With it, each forwarded client is
    // counted on its own.
    const behindProxy = createHub({ auth: { password: PASSWORD, sessionSecret: 'test-secret', trustProxy: true } });
    hubs.push(behindProxy);
    const viaProxy = (hub: Hub, password: string, client: string) => hub.app.inject({
      method: 'POST', url: '/api/login', payload: { password },
      headers: { 'x-forwarded-for': client }, remoteAddress: '10.1.1.1',
    });

    for (let i = 0; i < 5; i += 1) expect((await viaProxy(behindProxy, 'nope', '203.0.113.7')).statusCode).toBe(401);
    expect((await viaProxy(behindProxy, PASSWORD, '203.0.113.7')).statusCode).toBe(429);
    expect((await viaProxy(behindProxy, PASSWORD, '203.0.113.8')).statusCode).toBe(200);

    // Off (the default), the header is ignored: the five failures counted against the peer address,
    // so the *same* peer is locked out however it labels itself.
    const direct = createHub({ auth: { password: PASSWORD, sessionSecret: 'test-secret' } });
    hubs.push(direct);
    for (let i = 0; i < 5; i += 1) expect((await viaProxy(direct, 'nope', '203.0.113.7')).statusCode).toBe(401);
    expect((await viaProxy(direct, PASSWORD, '203.0.113.8')).statusCode).toBe(429);
  });
});
