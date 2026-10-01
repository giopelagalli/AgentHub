import { connect } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { JdMessage, JdStreamFrame } from '@agenthub/shared';
import { chimeWav, createMockJd, JD_MOCK_KEYS, JD_MOCK_TRANSCRIPT, type MockJd } from '@agenthub/mocks/jd';
import { routeAccess } from '../src/auth.js';
import { byteRange, JD_MAX_BODY } from '../src/jd.js';
import { optionsFromEnv } from '../src/options.js';
import { createHub, type Hub } from '../src/server.js';

/**
 * FR-C4, the hub's half of the JD web door (0069, 0070): `/api/jd/*` is the owner's, forwards to
 * JD with the bearer and nothing of the browser's credentials, maps JD's silences to 502/504,
 * passes voice and audio bytes through, and bridges the stream.
 */

const PASSWORD = 'let-me-in';
const DAEMON_TOKEN = 'daemon-token-abc';
const JD_TOKEN = 'jd-web-token-0123456789';

let hub: Hub | undefined;
let jd: MockJd | undefined;
let upstream: FastifyInstance | undefined;

afterEach(async () => {
  await hub?.stop();
  await jd?.close();
  await upstream?.close();
  hub = undefined; jd = undefined; upstream = undefined;
});

const portOf = (app: FastifyInstance): number => (app.server.address() as { port: number }).port;

async function startJd(): Promise<string> {
  jd = createMockJd({ token: JD_TOKEN, proactiveMs: 0, replyDelayMs: 0, name: 'Jarvis' });
  await jd.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${portOf(jd)}`;
}

/** A hub with a password and JD at `url`, plus a logged-in cookie. */
async function guarded(url: string, timeoutMs?: number): Promise<{ hub: Hub; cookie: string }> {
  hub = createHub({
    auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' },
    jd: { url, token: JD_TOKEN, ...(timeoutMs ? { timeoutMs } : {}) },
  });
  const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  return { hub, cookie: String(login.headers['set-cookie']).split(';')[0]! };
}

function handshake(port: number, path: string, headers: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...headers, '', '',
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

describe('the JD door: access', () => {
  it('classifies every JD route as the owner’s', () => {
    for (const [method, route] of [
      ['GET', '/api/jd/status'], ['GET', '/api/jd/history'], ['POST', '/api/jd/messages'], ['POST', '/api/jd/callback'],
      ['POST', '/api/jd/voice'], ['GET', '/api/jd/audio/:id'], ['GET', '/api/jd/keys'], ['GET', '/api/jd/stream'],
    ] as const) expect(routeAccess(method, route), `${method} ${route}`).toBe('owner');
  });

  it('answers only the owner session: no cookie, the daemon bearer and an API token are 401', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const minted = await hub.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { kind: 'assistant', label: 'JD' } });
    const apiToken = (minted.json() as { token: string }).token;
    for (const headers of [{}, { authorization: `Bearer ${DAEMON_TOKEN}` }, { authorization: `Bearer ${apiToken}` }]) {
      expect((await hub.app.inject({ method: 'GET', url: '/api/jd/history', headers })).statusCode).toBe(401);
      expect((await hub.app.inject({ method: 'POST', url: '/api/jd/messages', headers, payload: { text: 'hi' } })).statusCode).toBe(401);
      expect((await hub.app.inject({ method: 'GET', url: '/api/jd/status', headers })).statusCode).toBe(401);
    }
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/history', headers: { cookie } })).statusCode).toBe(200);
  });

  it('refuses a cross-origin write even with the cookie', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jd/messages', payload: { text: 'hi' },
      headers: { cookie, host: 'spark:4000', origin: 'http://spark:4010' },
    });
    expect(res.statusCode).toBe(403);
    expect(jd!.conversation.some((m) => m.text === 'hi')).toBe(false);
    const same = await hub.app.inject({
      method: 'POST', url: '/api/jd/messages', payload: { text: 'hi' },
      headers: { cookie, host: 'spark:4000', origin: 'http://spark:4000' },
    });
    expect(same.statusCode).toBe(200);
  });
});

describe('the JD door: forwarding', () => {
  it('adds the bearer, forwards method, query, body and type — and none of the browser’s credentials', async () => {
    upstream = Fastify();
    const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
    upstream.removeAllContentTypeParsers();
    upstream.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    upstream.all('/*', async (req) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: String(req.body ?? '') });
      return { messages: [] };
    });
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    const { hub, cookie } = await guarded(`http://127.0.0.1:${portOf(upstream)}`);

    const raw = '{"text":  "hello"}';
    const posted = await hub.app.inject({
      method: 'POST', url: '/api/jd/messages', payload: raw,
      headers: { cookie: `${cookie}; other=1`, 'content-type': 'application/json', 'x-extra': 'nope' },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toEqual({ messages: [] });
    await hub.app.inject({ method: 'GET', url: '/api/jd/history?limit=7', headers: { cookie } });

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /messages', 'GET /history?limit=7']);
    const [post, get] = seen;
    expect(post!.body).toBe(raw); // bytes, not a re-serialisation
    expect(post!.headers.authorization).toBe(`Bearer ${JD_TOKEN}`);
    expect(post!.headers['content-type']).toBe('application/json');
    for (const s of [post!, get!]) {
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers['x-extra']).toBeUndefined();
      expect(s.headers.authorization).toBe(`Bearer ${JD_TOKEN}`);
    }
  });

  it('talks to JD end to end: history, keys, a message, a tap answered with an edit', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const history = (await hub.app.inject({ method: 'GET', url: '/api/jd/history?limit=2', headers: { cookie } })).json() as { messages: JdMessage[] };
    expect(history.messages).toHaveLength(2);
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/keys', headers: { cookie } })).json()).toEqual({ keys: JD_MOCK_KEYS });

    const sent = (await hub.app.inject({ method: 'POST', url: '/api/jd/messages', headers: { cookie }, payload: { text: 'show me a button' } })).json() as { messages: JdMessage[] };
    expect(sent.messages.map((m) => m.from)).toEqual(['owner', 'jd']);
    const keyboard = sent.messages[1]!;
    expect(keyboard.buttons?.[0]?.[0]?.data).toBe('mood:great');

    const tapped = (await hub.app.inject({ method: 'POST', url: '/api/jd/callback', headers: { cookie }, payload: { data: 'mood:great' } })).json() as { messages: JdMessage[] };
    expect(tapped.messages).toHaveLength(1);
    expect(tapped.messages[0]).toMatchObject({ id: keyboard.id, edit: true });
    expect(tapped.messages[0]!.buttons).toBeUndefined();
  });

  it('answers status locally, with JD’s name', async () => {
    const { hub, cookie } = await guarded(await startJd());
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/status', headers: { cookie } })).json())
      .toEqual({ configured: true, reachable: true, name: 'Jarvis' });
  });

  it('says not configured without JD, or without a password', async () => {
    hub = createHub({ auth: { password: PASSWORD, sessionSecret: 'test-secret' } });
    const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/status', headers: { cookie } })).json())
      .toEqual({ configured: false, reachable: false });
    const res = await hub.app.inject({ method: 'POST', url: '/api/jd/messages', headers: { cookie }, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(503);
    await hub.stop();

    hub = createHub({ jd: { url: 'http://127.0.0.1:9', token: JD_TOKEN } });
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/status' })).json()).toEqual({ configured: false, reachable: false });
  });

  it('is 502 when JD is not reachable, and reports it unreachable', async () => {
    const { hub, cookie } = await guarded('http://127.0.0.1:9');
    const res = await hub.app.inject({ method: 'POST', url: '/api/jd/messages', headers: { cookie }, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'JD is not reachable' });
    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/status', headers: { cookie } })).json())
      .toEqual({ configured: true, reachable: false });
  });

  it('is 504 when JD takes longer than the timeout', async () => {
    upstream = Fastify();
    upstream.post('/messages', () => new Promise(() => {}));
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    const { hub, cookie } = await guarded(`http://127.0.0.1:${portOf(upstream)}`, 150);
    const res = await hub.app.inject({ method: 'POST', url: '/api/jd/messages', headers: { cookie }, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(504);
    // Close the hung request's socket so the upstream can close.
    upstream.server.closeAllConnections();
  });

  it('never passes JD’s 401 on as the browser’s own 401', async () => {
    jd = createMockJd({ token: 'a-different-token', proactiveMs: 0 });
    await jd.listen({ port: 0, host: '127.0.0.1' });
    const { hub, cookie } = await guarded(`http://127.0.0.1:${portOf(jd)}`);
    const res = await hub.app.inject({ method: 'GET', url: '/api/jd/history', headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/JD_WEB_TOKEN/);
  });
});

describe('the JD door: voice and audio', () => {
  it('passes a recorded voice note through as raw bytes with its type', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jd/voice', payload: bytes, headers: { cookie, 'content-type': 'audio/mp4' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transcript: string; messages: JdMessage[] };
    expect(body.transcript).toBe(JD_MOCK_TRANSCRIPT);
    expect(body.messages[1]!.audio).toEqual({ id: 'chime', mime: 'audio/wav' });
    expect(jd!.voices).toHaveLength(1);
    expect(jd!.voices[0]!.type).toBe('audio/mp4');
    expect(jd!.voices[0]!.bytes.equals(bytes)).toBe(true);
  });

  it('refuses a body over 10 MB with 413 before JD sees it', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jd/voice', payload: Buffer.alloc(JD_MAX_BODY + 1), headers: { cookie, 'content-type': 'audio/webm' },
    });
    expect(res.statusCode).toBe(413);
    expect(jd!.voices).toHaveLength(0);
  });

  it('serves JD’s audio bytes, whole and by range', async () => {
    const { hub, cookie } = await guarded(await startJd());
    const wav = chimeWav();
    const whole = await hub.app.inject({ method: 'GET', url: '/api/jd/audio/chime', headers: { cookie } });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/wav');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload.equals(wav)).toBe(true);

    const part = await hub.app.inject({ method: 'GET', url: '/api/jd/audio/chime', headers: { cookie, range: 'bytes=0-1' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-1/${wav.length}`);
    expect(part.rawPayload.equals(wav.subarray(0, 2))).toBe(true);

    expect((await hub.app.inject({ method: 'GET', url: '/api/jd/audio/nope', headers: { cookie } })).statusCode).toBe(404);
  });

  it('reads byte ranges the way browsers write them', () => {
    expect(byteRange(undefined, 100)).toBeUndefined();
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBeNull();
    expect(byteRange('bytes=0-1,4-5', 100)).toBeUndefined();
  });
});

describe('the JD door: the stream', () => {
  const nextFrame = (socket: WebSocket): Promise<JdStreamFrame> =>
    new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(String(data)) as JdStreamFrame)));
  const closed = (socket: WebSocket): Promise<number> => new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };

  async function openStream(): Promise<{ port: number; socket: WebSocket }> {
    const { hub, cookie } = await guarded(await startJd());
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = portOf(hub.app);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/jd/stream`, { headers: { cookie } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await until(() => jd!.streams() === 1);
    return { port, socket };
  }

  it('relays JD’s frames to the browser', async () => {
    const { socket } = await openStream();
    const typing = nextFrame(socket);
    jd!.push({ type: 'typing', on: true });
    expect(await typing).toEqual({ type: 'typing', on: true });
    const message: JdMessage = { id: 'p1', from: 'jd', at: 1, text: '<b>Briefing</b>', format: 'html' };
    const said = nextFrame(socket);
    jd!.push({ type: 'message', message });
    expect(await said).toEqual({ type: 'message', message });
    socket.close();
  });

  it('closes JD’s side when the browser goes, and the browser’s when JD goes', async () => {
    const first = await openStream();
    first.socket.close();
    await until(() => jd!.streams() === 0);

    const socket = new WebSocket(`ws://127.0.0.1:${first.port}/api/jd/stream`, { headers: { cookie: await cookieFor(hub!) } });
    await new Promise((resolve) => socket.once('open', resolve));
    await until(() => jd!.streams() === 1);
    const gone = closed(socket);
    await jd!.close();
    expect(await gone).not.toBe(1006);
  });

  it('refuses the upgrade without the session, with an API token, and from another origin', async () => {
    const { hub, cookie } = await guarded(await startJd());
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = portOf(hub.app);
    expect(await handshake(port, '/api/jd/stream')).toContain('401');
    expect(await handshake(port, '/api/jd/stream', [`Authorization: Bearer ${DAEMON_TOKEN}`])).toContain('401');
    expect(await handshake(port, '/api/jd/stream', [`Cookie: ${cookie}`, `Origin: http://127.0.0.1:${port + 10}`])).toContain('403');
    expect(await handshake(port, '/api/jd/stream', [`Cookie: ${cookie}`, `Origin: http://127.0.0.1:${port}`])).toContain('101');
  });

  it('closes the browser’s socket with a reason when JD is not there', async () => {
    const { hub, cookie } = await guarded('http://127.0.0.1:9');
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const socket = new WebSocket(`ws://127.0.0.1:${portOf(hub.app)}/api/jd/stream`, { headers: { cookie } });
    const reason = await new Promise<string>((resolve) => socket.once('close', (_code, why) => resolve(String(why))));
    expect(reason).toBe('JD is not reachable');
  });
});

async function cookieFor(h: Hub): Promise<string> {
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  return String(login.headers['set-cookie']).split(';')[0]!;
}

describe('JD in the environment', () => {
  it('needs both JD_URL and JD_WEB_TOKEN', () => {
    const quiet = () => {};
    expect(optionsFromEnv({ JD_URL: 'http://127.0.0.1:8891', JD_WEB_TOKEN: 't' }, quiet).options.jd)
      .toEqual({ url: 'http://127.0.0.1:8891', token: 't' });
    const lines: string[] = [];
    expect(optionsFromEnv({ JD_URL: 'http://127.0.0.1:8891' }, (l) => lines.push(l)).options.jd).toBeUndefined();
    expect(lines.some((l) => l.includes('JD_WEB_TOKEN is not set'))).toBe(true);
  });
});
