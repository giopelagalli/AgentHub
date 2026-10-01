import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import type { JdStatus } from '@agenthub/shared';
import { originAllowed } from './projects/terminal.js';

/**
 * FR-C4 — the JD web door, the hub's half (decisions 0069, 0070). JD (the owner's assistant, in
 * telegramManager) serves a small HTTP API on the tailnet behind a bearer; this plugin puts it under
 * the owner's login as `/api/jd/*`, so the UI's JD page can talk to it from a phone.
 *
 * What it forwards and what it does not:
 *  - Only the contract's routes, each by name — not a wildcard, so the hub never becomes a general
 *    proxy into JD. Method, query, body bytes and `Content-Type` go through as they came; the
 *    bearer is added here. Nothing else from the browser does: no cookie, no `Authorization`.
 *  - JD's 401/403 is answered 502, never passed on: the browser's own 401 means "your session is
 *    gone" and reloads the page, which a wrong `JD_WEB_TOKEN` must not turn into a loop.
 *  - Unreachable is 502 `{ error: 'JD is not reachable' }`; past `timeoutMs` (120 s) it is 504.
 *  - `/audio/:id` answers byte ranges itself from the bytes JD sent: Safari will not play an
 *    `<audio>` whose server cannot, and JD is not asked to.
 *
 * Access is `owner` under `routeAccess` (no `/api/jd/*` route is in the daemon or assistant lists),
 * so the global auth hook already demands the cookie and a same-origin write; the stream's upgrade
 * also checks its `Origin` itself, as the terminal's does. The door only opens on a hub with a
 * password — without one `/api/jd/status` still answers, `configured: false`.
 */

export const JD_STREAM_ROUTE = '/api/jd/stream';

/** Bodies the door carries at most; JD refuses more with its own 413, the hub before it. */
export const JD_MAX_BODY = 10 * 1024 * 1024;

/** How long a forwarded request may take: long model work answers when it is done. */
export const JD_TIMEOUT_MS = 120_000;

/** `/api/jd/status` asks `/health`, which answers at once or not at all. */
const HEALTH_TIMEOUT_MS = 5_000;

export interface JdDoorOptions {
  /** JD's web API, e.g. `http://127.0.0.1:8891`. */
  url: string;
  /** `JD_WEB_TOKEN`, the bearer JD expects. Never logged, never sent to the browser. */
  token: string;
  timeoutMs?: number;
}

/** A close code a server may send on; anything else JD closed with is reported as 1011. */
const relayableClose = (code: number): number =>
  [1000, 1001, 1011, 1012, 1013].includes(code) || (code >= 3000 && code <= 4999) ? code : 1011;

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against `size`; null when unsatisfiable, undefined when not a range at all. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

/** Only an audio type reaches the browser from `/audio/:id`; anything else is bytes to save, never a page. */
export const audioType = (type: string): string => (/^audio\/[\w.+-]+/i.test(type) ? type : 'application/octet-stream');

export interface JdRoutesOptions {
  jd?: JdDoorOptions;
  /** `JD_URL` is set but the hub has no password, so the door is shut: status says why. */
  shutForNoPassword?: boolean;
}

export const jdRoutes: FastifyPluginAsync<JdRoutesOptions> = async (app, { jd, shutForNoPassword }) => {
  // JD's answers are served on the hub's own origin, where the owner's session can run shells: the
  // browser must never sniff one of them into a page.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  // In-flight requests to JD end with the hub, not up to 120 s after it was asked to stop.
  const closing = new AbortController();
  app.addHook('preClose', async () => { closing.abort(); });
  const deadline = (ms: number): AbortSignal => AbortSignal.any([closing.signal, AbortSignal.timeout(ms)]);

  app.get('/api/jd/status', async (): Promise<JdStatus> => {
    if (!jd) return { configured: false, reachable: false, ...(shutForNoPassword ? { reason: 'no-password' as const } : {}) };
    try {
      const res = await fetch(`${jd.url}/health`, {
        headers: { authorization: `Bearer ${jd.token}` }, signal: deadline(HEALTH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) return { configured: true, reachable: false, reason: 'token' };
      if (!res.ok) return { configured: true, reachable: false, reason: 'unreachable' };
      const body = await res.json() as { name?: unknown };
      return { configured: true, reachable: true, ...(typeof body.name === 'string' && body.name ? { name: body.name } : {}) };
    } catch {
      return { configured: true, reachable: false, reason: 'unreachable' };
    }
  });

  if (!jd) {
    // The page asks for these too; say what is wrong instead of a bare 404. The stream is a real
    // websocket route even here, so an upgrade is answered and closed with the reason.
    app.get(JD_STREAM_ROUTE, { websocket: true }, (socket: WebSocket) => { socket.close(1011, 'JD is not configured'); });
    app.all('/api/jd/*', async (_req, reply) => reply.code(503).send({ error: 'JD is not configured' }));
    return;
  }

  const base = jd.url.replace(/\/+$/, '');
  const timeoutMs = jd.timeoutMs ?? JD_TIMEOUT_MS;

  // Every body in this scope stays the bytes the browser sent: JSON is not parsed and re-serialised,
  // and a voice note in whatever container the browser recorded goes through untouched.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: JD_MAX_BODY }, (_req, body, done) => done(null, body));

  /** Asks JD, and answers the browser with what JD said — or with why JD said nothing. */
  const forward = async (req: FastifyRequest, reply: FastifyReply, path: string): Promise<{ status: number; type: string; bytes: Buffer } | null> => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const type = req.headers['content-type'];
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
    let res: Response;
    let bytes: Buffer;
    try {
      res = await fetch(`${base}${path}${query}`, {
        method: req.method,
        headers: { authorization: `Bearer ${jd.token}`, ...(body && type ? { 'content-type': type } : {}) },
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: deadline(timeoutMs),
      });
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (closing.signal.aborted) {
        reply.code(503).send({ error: 'the hub is shutting down' });
        return null;
      }
      const timedOut = (err as Error).name === 'TimeoutError';
      reply.code(timedOut ? 504 : 502).send({ error: timedOut ? 'JD took too long to answer' : 'JD is not reachable' });
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      console.warn(`[jd] JD refused the hub's token on ${req.method} ${path} — JD_WEB_TOKEN differs between the two .env files`);
      reply.code(502).send({ error: 'JD refused the hub’s token — check JD_WEB_TOKEN in both .env files' });
      return null;
    }
    return { status: res.status, type: res.headers.get('content-type') ?? 'application/octet-stream', bytes };
  };

  const relay = (path: (req: FastifyRequest) => string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const answer = await forward(req, reply, path(req));
    if (answer) return reply.code(answer.status).type(answer.type).send(answer.bytes);
    return reply;
  };

  app.get('/api/jd/health', relay(() => '/health'));
  app.get('/api/jd/history', relay(() => '/history'));
  app.get('/api/jd/keys', relay(() => '/keys'));
  app.post('/api/jd/messages', relay(() => '/messages'));
  app.post('/api/jd/callback', relay(() => '/callback'));
  app.post('/api/jd/voice', relay(() => '/voice'));

  app.get('/api/jd/audio/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const answer = await forward(req, reply, `/audio/${encodeURIComponent(id)}`);
    if (!answer) return reply;
    reply.code(answer.status).type(audioType(answer.type));
    if (answer.status !== 200) return reply.send(answer.bytes);
    // A voice note never changes under its id, so the browser need not ask twice.
    reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=86400');
    const range = byteRange(req.headers.range, answer.bytes.length);
    if (range === undefined) return reply.send(answer.bytes);
    if (range === null) {
      return reply.code(416).header('content-range', `bytes */${answer.bytes.length}`).send();
    }
    return reply.code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${answer.bytes.length}`)
      .send(answer.bytes.subarray(range.start, range.end + 1));
  });

  // The stream: one socket to JD per browser socket, closed together.
  const bridges = new Set<{ browser: WebSocket; upstream: WebSocket }>();
  app.addHook('onClose', async () => {
    for (const { browser, upstream } of bridges) {
      upstream.terminate();
      browser.terminate();
    }
    bridges.clear();
  });

  app.get(JD_STREAM_ROUTE, {
    websocket: true,
    // Before the upgrade: a page on the preview origin carries the owner's cookie (same site) and
    // must not get as far as holding JD's stream. The refusal hangs up its own connection.
    onRequest: async (req, reply) => {
      if (originAllowed(req.headers.origin, req.headers.host)) return;
      console.warn(`[jd] refused a stream upgrade from origin ${req.headers.origin}`);
      reply.raw.on('finish', () => reply.raw.socket?.end());
      return reply.code(403).send({ error: 'cross-origin' });
    },
  }, (browser: WebSocket) => {
    const upstream = new WebSocket(`${base.replace(/^http/, 'ws')}/stream`, {
      headers: { authorization: `Bearer ${jd.token}` },
      handshakeTimeout: HEALTH_TIMEOUT_MS,
    });
    const bridge = { browser, upstream };
    bridges.add(bridge);
    let refused: string | null = null;

    // Server to browser only: the contract has the browser listen, never speak, on this socket.
    upstream.on('message', (data, isBinary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
    });
    upstream.on('unexpected-response', (_req, res) => {
      refused = res.statusCode === 401 || res.statusCode === 403 ? 'JD refused the hub’s token' : `JD answered ${res.statusCode}`;
      upstream.terminate();
    });
    upstream.on('error', () => { /* reported by the close that follows */ });
    upstream.on('close', (code) => {
      bridges.delete(bridge);
      if (browser.readyState !== WebSocket.OPEN && browser.readyState !== WebSocket.CONNECTING) return;
      if (refused) browser.close(1011, refused);
      else if (code === 1006) browser.close(1011, 'JD is not reachable');
      else browser.close(relayableClose(code), 'JD closed the stream');
    });
    browser.on('close', () => {
      bridges.delete(bridge);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
      else upstream.terminate();
    });
  });
};
