import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import type { PreviewConfig, PreviewStatus } from '@agenthub/shared';
import { secretsStripped } from '@agenthub/shared/shell';
import type { ProjectService } from './service.js';
import { InvalidSlugError } from './schema.js';

/**
 * FR-B1 — the preview. A project may declare a dev server in its manifest; the hub runs it in the
 * project's `workspace/` on its own machine and serves it to the owner's browser under
 * `/preview/<slug>/`, behind the session (decision 0021). Nothing about the child is exposed to the
 * network directly: it binds a loopback port this file is the only door to.
 */

/** Ports a preview may be asked to listen on: never a privileged one, never out of range. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;
/** Cap on one `cmd`, so a manifest cannot hand `spawn` an unbounded argv. */
const MAX_ARGV = 32;
/** Generous — an inline `node -e` script is a legitimate command — but not unbounded. */
const MAX_ARG_LENGTH = 4000;

/** Lines of output kept per project, and how many of them the status hands back. */
const LOG_RING = 200;
export const LOG_TAIL = 50;

/** How long a preview may go without a proxied request before the hub stops it. */
export const DEFAULT_IDLE_MS = 30 * 60_000;
/** How often the idle sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;
/** How long `start` waits for the port to accept a connection before answering anyway. */
const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** How long a stopped process has to exit on SIGTERM before it is killed. */
const KILL_ESCALATION_MS = 3000;

export const previewUrl = (slug: string): string => `/preview/${slug}/`;

/** Headers the upstream must never see: the hub's session cookie and its own credentials. */
const STRIPPED_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];

/**
 * Validates an owner- or agent-supplied preview config. Everything here ends up as `spawn` argv, a
 * TCP port and an iframe path, so each is checked rather than trusted: the config is written to a
 * manifest that the hub will later execute.
 */
export function validatePreview(body: unknown): { preview: PreviewConfig } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const cmd = b.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > MAX_ARGV) return { error: 'cmd must be a non-empty argv array' };
  if (!cmd.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_ARG_LENGTH)) {
    return { error: 'cmd must be an array of non-empty strings' };
  }
  const port = b.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return { error: `port must be an integer between ${MIN_PORT} and ${MAX_PORT}` };
  }
  const path = b.path;
  if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
    return { error: 'path must start with /' };
  }
  return {
    preview: { cmd: cmd as string[], port, ...(typeof path === 'string' ? { path } : {}) },
  };
}

interface Running {
  config: PreviewConfig;
  child: ChildProcess;
  startedAt: number;
  /** Set by `stop`, so the child's own exit isn't read as a crash. */
  stopping: boolean;
  /** When the proxy last saw traffic for this project; the idle sweep measures from here. */
  lastSeenAt: number;
}

export interface PreviewSupervisorDeps {
  projects: ProjectService;
  now?: () => number;
  idleMs?: number;
  readyTimeoutMs?: number;
}

/**
 * One dev server per project, run in its workspace on the hub's machine.
 *
 * Children are spawned detached so the pid doubles as a process-group id: a dev server is almost
 * always a wrapper (`npm run dev` → vite → esbuild), and only a negative-pid signal takes the whole
 * tree down — the same discipline `node-daemon`'s supervisor and `runShellTask` use. The environment
 * is `secretsStripped()`: a preview is project code the hub runs, and project code never sees the
 * owner's keys.
 */
export class PreviewSupervisor {
  private readonly running = new Map<string, Running>();
  /** Output kept per slug, and kept after the process is gone — a crash is read from its last lines. */
  private readonly logs = new Map<string, string[]>();
  /** Set on exit when nobody asked for it; cleared by the next `start`. */
  private readonly crashed = new Set<string>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly readyTimeoutMs: number;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly deps: PreviewSupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /** The port a proxied request should go to, or null when nothing is running for this project. */
  portOf(slug: string): number | null {
    return this.running.get(slug)?.config.port ?? null;
  }

  /** Marks the project as in use, so the idle sweep leaves it alone. Called per proxied request. */
  touch(slug: string): void {
    const rec = this.running.get(slug);
    if (rec) rec.lastSeenAt = this.now();
  }

  async status(slug: string): Promise<PreviewStatus> {
    const config = (await (await this.deps.projects.get(slug)).manifest()).preview;
    const rec = this.running.get(slug);
    return {
      configured: !!config,
      running: !!rec,
      port: rec?.config.port ?? config?.port ?? null,
      url: previewUrl(slug),
      startedAt: rec?.startedAt ?? null,
      config: config ?? null,
      crashed: this.crashed.has(slug),
      log: (this.logs.get(slug) ?? []).slice(-LOG_TAIL),
    };
  }

  /**
   * Starts the project's dev server and waits for its port to answer. Idempotent: a preview already
   * running is left alone. The wait is bounded — a server that is slow to bind still counts as
   * started, and its log tail is what says whether it is coming up or failing.
   */
  async start(slug: string): Promise<PreviewStatus> {
    if (this.running.has(slug)) return this.status(slug);
    const bundle = await this.deps.projects.get(slug);
    const config = (await bundle.manifest()).preview;
    if (!config) throw new PreviewError(400, 'this project has no preview configured');

    this.crashed.delete(slug);
    this.logs.set(slug, []);
    const [cmd, ...args] = config.cmd as [string, ...string[]];
    const child = spawn(cmd, args, {
      cwd: bundle.workspace,
      env: {
        ...secretsStripped(),
        PORT: String(config.port),
        // Dev servers are served under a base path, and the one that matters is this project's; a
        // build script can read it rather than have the owner repeat it in two places.
        AGENTHUB_PREVIEW_BASE: previewUrl(slug),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rec: Running = { config, child, startedAt: this.now(), stopping: false, lastSeenAt: this.now() };
    this.running.set(slug, rec);

    this.pipeLog(slug, child, 'out');
    this.pipeLog(slug, child, 'err');
    child.on('error', (err) => {
      this.append(slug, `err: ${err.message}`);
      if (this.running.get(slug) === rec) {
        this.running.delete(slug);
        this.crashed.add(slug);
      }
    });
    child.on('exit', (code, signal) => {
      if (this.running.get(slug) !== rec) return;
      this.running.delete(slug);
      if (!rec.stopping) {
        this.crashed.add(slug);
        this.append(slug, `err: preview exited (${signal ?? `code ${code}`})`);
      }
      if (this.running.size === 0) this.stopSweeping();
    });

    this.startSweeping();
    await this.awaitPort(rec);
    return this.status(slug);
  }

  /** Stops the project's dev server, taking its whole process group with it. */
  async stop(slug: string): Promise<PreviewStatus> {
    const rec = this.running.get(slug);
    if (!rec) return this.status(slug);
    rec.stopping = true;
    this.running.delete(slug);
    if (this.running.size === 0) this.stopSweeping();
    await terminate(rec.child);
    return this.status(slug);
  }

  async restart(slug: string): Promise<PreviewStatus> {
    await this.stop(slug);
    return this.start(slug);
  }

  /**
   * Stops every preview whose last proxied request is older than the idle window. A dev server is a
   * file watcher and a compiler; one nobody has looked at for half an hour is pure cost.
   */
  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    const idle = [...this.running.entries()].filter(([, rec]) => rec.lastSeenAt <= cutoff).map(([slug]) => slug);
    for (const slug of idle) {
      this.append(slug, 'out: preview stopped after 30 minutes with nobody watching');
      await this.stop(slug);
    }
  }

  /** Every preview goes down with the hub: these are children of this process, not services. */
  async stopAll(): Promise<void> {
    this.stopSweeping();
    await Promise.all([...this.running.keys()].map((slug) => this.stop(slug)));
  }

  private startSweeping(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => { void this.sweepIdle(); }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  private stopSweeping(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private pipeLog(slug: string, child: ChildProcess, which: 'out' | 'err'): void {
    const stream = which === 'out' ? child.stdout : child.stderr;
    let buffer = '';
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.append(slug, `${which}: ${line.replace(/\r$/, '')}`);
    });
  }

  private append(slug: string, line: string): void {
    const ring = this.logs.get(slug) ?? [];
    ring.push(line);
    if (ring.length > LOG_RING) ring.splice(0, ring.length - LOG_RING);
    this.logs.set(slug, ring);
  }

  /** Resolves once the port accepts a connection, the process dies, or the wait runs out. */
  private async awaitPort(rec: Running): Promise<void> {
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      if (rec.child.exitCode !== null || rec.child.signalCode !== null) return;
      if (await reachable(rec.config.port)) return;
      if (this.now() >= deadline) return;
      await sleep(100);
    }
  }
}

/** Carries the status the route should answer with. */
export class PreviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'PreviewError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/** SIGTERM the group, then SIGKILL it if it is still there — `node-daemon`'s escalation, per project. */
function terminate(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    const pid = child.pid;
    const killTimer = setTimeout(() => {
      // The group's id could have been recycled by the time this fires, so it is probed first.
      try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }, KILL_ESCALATION_MS);
    killTimer.unref?.();
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    try { process.kill(-pid, 'SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
  });
}

/** What a request that arrives while nothing is running gets — readable inside the iframe. */
function notRunningHtml(slug: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Preview stopped</title>` +
    `<body style="font:14px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#bbb">` +
    `<p>The preview for <b>${slug.replace(/[^a-z0-9-]/g, '')}</b> is not running.</p></body>`;
}

/** The upstream request's headers: everything the browser sent, minus the hub's own credentials. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  for (const name of STRIPPED_REQUEST_HEADERS) delete out[name];
  // The dev server is addressed on loopback and must see that, not the hub's public name — a Vite
  // or Next server checks Host against its own allow-list.
  out.host = `127.0.0.1:${port}`;
  return out;
}

export interface PreviewRoutesOptions {
  projects: ProjectService;
  /** Re-reads the project list and broadcasts it, so a config change reaches the UI. */
  refresh?: () => Promise<void>;
  now?: () => number;
  idleMs?: number;
  readyTimeoutMs?: number;
  /** Receives the supervisor once it is built, so tests (and the hub) can reach it. */
  onReady?: (supervisor: PreviewSupervisor) => void;
}

/**
 * The preview plugin: the owner's config and lifecycle routes under `/api/projects/:slug/preview`,
 * and the proxy itself at `/preview/:slug/*`.
 *
 * The proxy forwards the path **unchanged**. The dev server is configured with `/preview/<slug>/`
 * as its base path, so that is the path it serves on; rewriting the prefix away would strand every
 * absolute asset URL the app emits (decision 0031).
 */
export async function previewRoutes(app: FastifyInstance, opts: PreviewRoutesOptions): Promise<void> {
  const { projects } = opts;
  const supervisor = new PreviewSupervisor({
    projects,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
  });
  opts.onReady?.(supervisor);
  app.addHook('onClose', async () => { await supervisor.stopAll(); });

  /** Answers 400/404 the way every other project route does, and returns null once it has. */
  const resolve = async (slug: string, reply: FastifyReply): Promise<boolean> => {
    try {
      await projects.get(slug);
      return true;
    } catch (err) {
      reply.code(err instanceof InvalidSlugError ? 400 : 404)
        .send({ error: err instanceof InvalidSlugError ? 'invalid slug' : 'unknown project' });
      return false;
    }
  };

  app.get('/api/projects/:slug/preview', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolve(slug, reply))) return reply;
    return supervisor.status(slug);
  });

  app.put('/api/projects/:slug/preview', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const validated = validatePreview(req.body);
    if ('error' in validated) return reply.code(400).send({ error: validated.error });
    if (!(await resolve(slug, reply))) return reply;
    const bundle = await projects.get(slug);
    await bundle.setPreview(validated.preview);
    await bundle.commit('owner: set preview');
    // The command changed under whatever is running; the next start is the new one.
    await supervisor.stop(slug);
    await opts.refresh?.();
    return supervisor.status(slug);
  });

  app.delete('/api/projects/:slug/preview', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolve(slug, reply))) return reply;
    const bundle = await projects.get(slug);
    await bundle.setPreview(undefined);
    await bundle.commit('owner: clear preview');
    await supervisor.stop(slug);
    await opts.refresh?.();
    return supervisor.status(slug);
  });

  const lifecycle: Record<string, (slug: string) => Promise<PreviewStatus>> = {
    start: (slug) => supervisor.start(slug),
    stop: (slug) => supervisor.stop(slug),
    restart: (slug) => supervisor.restart(slug),
  };
  for (const [action, apply] of Object.entries(lifecycle)) {
    app.post(`/api/projects/:slug/preview/${action}`, async (req, reply) => {
      const { slug } = req.params as { slug: string };
      if (!(await resolve(slug, reply))) return reply;
      try {
        return await apply(slug);
      } catch (err) {
        if (err instanceof PreviewError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    });
  }

  /**
   * One proxied request. The reply is hijacked and the upstream's own status, headers and body are
   * written to the socket verbatim — a dev server's streamed HTML, its SSE and its 304s all have to
   * reach the iframe as they were sent.
   */
  const proxy = (req: FastifyRequest, reply: FastifyReply): void => {
    const { slug } = req.params as { slug: string };
    const port = supervisor.portOf(slug);
    if (port === null) {
      void reply.code(503).type('text/html; charset=utf-8').send(notRunningHtml(slug));
      return;
    }
    supervisor.touch(slug);
    reply.hijack();
    const upstream = httpRequest(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, port) },
      (res) => {
        reply.raw.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(reply.raw);
      },
    );
    upstream.on('error', () => {
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      reply.raw.end(notRunningHtml(slug));
    });
    reply.raw.on('close', () => { upstream.destroy(); });
    req.raw.pipe(upstream);
  };

  /**
   * The HMR socket. @fastify/websocket has already accepted the upgrade by the time this runs, so
   * the two sockets are bridged frame by frame rather than at the TCP level; the subprotocol the
   * browser asked for is carried over so a `vite-hmr` client reaches the server that expects it.
   */
  const proxyWs = (source: WebSocket, req: FastifyRequest): void => {
    const { slug } = req.params as { slug: string };
    const port = supervisor.portOf(slug);
    if (port === null) return source.close(1011, 'preview not running');
    supervisor.touch(slug);
    // Only what the upstream needs to answer: no cookie, and none of the handshake headers `ws`
    // writes itself.
    const headers: Record<string, string> = {};
    if (typeof req.headers.origin === 'string') headers.origin = req.headers.origin;
    // The subprotocol is forwarded as a raw header rather than as a requested subprotocol. Vite
    // routes its HMR upgrade on `sec-websocket-protocol: vite-hmr` but never echoes it back, and a
    // `ws` client that asked for a subprotocol treats an answer without one as a failed handshake —
    // asking for it would break the very server it is there for.
    const requested = req.headers['sec-websocket-protocol'];
    if (typeof requested === 'string') headers['sec-websocket-protocol'] = requested;
    const target = new WebSocket(`ws://127.0.0.1:${port}${req.url}`, [], { headers });

    const pending: { data: WebSocket.RawData; binary: boolean }[] = [];
    const close = (): void => {
      if (source.readyState === WebSocket.OPEN) source.close();
      if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) target.close();
    };
    source.on('message', (data, binary) => {
      supervisor.touch(slug);
      if (target.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
      else if (target.readyState === WebSocket.OPEN) target.send(data, { binary });
    });
    target.on('open', () => {
      for (const { data, binary } of pending.splice(0)) target.send(data, { binary });
    });
    target.on('message', (data, binary) => {
      supervisor.touch(slug);
      if (source.readyState === WebSocket.OPEN) source.send(data, { binary });
    });
    source.on('close', close);
    target.on('close', close);
    source.on('error', close);
    target.on('error', close);
  };

  // The proxy routes live in their own context so that the parser below reaches them and nothing
  // else: bodies passing through are forwarded, never read, and a JSON parser that consumed
  // `req.raw` would leave the handler with nothing to pipe.
  await app.register(async (proxied) => {
    proxied.removeAllContentTypeParsers();
    proxied.addContentTypeParser('*', (_req, payload, done) => { done(null, payload); });
    // GET carries the websocket upgrade as well as the ordinary page loads; the rest of the methods
    // are a second route because a websocket handler may only be declared on a GET one. HEAD is left
    // out: Fastify already derives it from the GET route, and declaring it twice is an error.
    const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
    for (const url of ['/preview/:slug', '/preview/:slug/*']) {
      proxied.route({ method: 'GET', url, handler: proxy, wsHandler: proxyWs });
      proxied.route({ method: [...OTHER_METHODS], url, handler: proxy });
    }
  });
}
