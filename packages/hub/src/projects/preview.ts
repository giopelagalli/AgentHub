import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  createServer, request as httpRequest,
  type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { pipeline } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PreviewConfig, PreviewConfigInput, PreviewSnapshot, PreviewStatus } from '@agenthub/shared';
import { safeEqual, secretsStripped } from '@agenthub/shared/shell';
import type { ProjectService } from './service.js';
import { InvalidSlugError, SLUG_RE } from './schema.js';

/**
 * FR-B1 — the preview. A project may declare a dev server in its manifest; the hub runs it in the
 * project's `workspace/` on its own machine and serves it to the owner's browser.
 *
 * It is served from **its own listener on its own port**, never from the hub's (decision 0040). The
 * document a preview serves is project code — written by agents, or cloned from a repository — and
 * on the hub's origin it could read and drive `/api/*` as the owner with the session cookie, with
 * the iframe's `sandbox` doing nothing to stop it, because `sandbox` is not an origin boundary.
 * A separate port is a separate origin, so the same-origin policy does the work.
 *
 * Nothing but previews is served there: no API, no UI, and no ambient credential. Access is a
 * per-project capability in the path — `/p/<slug>/<cap>/…` — because a port with no session is a
 * port with no way to tell the owner from anyone else who can reach it.
 */

/** Ports a preview may be asked to listen on: never a privileged one, never out of range. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;
/** Cap on one `cmd`, so a manifest cannot hand `spawn` an unbounded argv. */
const MAX_ARGV = 32;
/** Generous — an inline `node -e` script is a legitimate command — but not unbounded. */
const MAX_ARG_LENGTH = 4000;

/** Where the preview listener sits when nothing says otherwise: the hub's port plus ten. */
export const PREVIEW_PORT_OFFSET = 10;

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
/** How long an upgrade has to reach the dev server before both sockets are dropped. */
const UPGRADE_TIMEOUT_MS = 10_000;

/** The capability, as it appears in a preview path. */
const CAP_RE = /^[0-9a-f]{32}$/;

export const newCapability = (): string => randomBytes(16).toString('hex');

/** The path every preview is served under — and the base path its dev server must be built with. */
export const previewBase = (slug: string, cap: string): string => `/p/${slug}/${cap}/`;

/**
 * Splits a preview request's path. Returns null for anything that is not a preview — which, on the
 * preview listener, is everything else there is.
 */
export function parsePreviewPath(url: string | undefined): { slug: string; cap: string; trailing: boolean } | null {
  const path = (url ?? '').split('?')[0] ?? '';
  const parts = path.split('/');
  // ['', 'p', slug, cap, ...rest]
  if (parts.length < 4 || parts[1] !== 'p') return null;
  const slug = parts[2] ?? '';
  const cap = parts[3] ?? '';
  if (!SLUG_RE.test(slug) || !CAP_RE.test(cap)) return null;
  return { slug, cap, trailing: parts.length > 4 };
}

/** Headers the upstream must never see: anything that would let it act as the owner. */
const STRIPPED_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];

/**
 * Response headers the proxy owns rather than forwards. The hop-by-hop ones describe *this*
 * connection, not the one to the browser; `set-cookie` is dropped because a dev server has no
 * business putting cookies on the preview origin, and a confused one should not be able to.
 */
const STRIPPED_RESPONSE_HEADERS = [
  'set-cookie', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding',
  'proxy-authenticate', 'proxy-connection', 'trailer', 'te',
];

/**
 * Validates an owner- or agent-supplied preview config. Everything here ends up as `spawn` argv, a
 * TCP port and an iframe path, so each is checked rather than trusted: the config is written to a
 * manifest that the hub will later execute. The capability is not an input — the hub mints it.
 */
export function validatePreview(body: unknown): { preview: PreviewConfigInput } | { error: string } {
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

/** Where a browser reaches this project's preview: the public base if there is one, else this host. */
export function previewUrl(
  where: { publicBase?: string; port: number }, hostHeader: string | undefined, https: boolean,
  slug: string, cap: string,
): string {
  const base = previewBase(slug, cap);
  if (where.publicBase) return `${where.publicBase.replace(/\/+$/, '')}${base}`;
  // The hub and the preview share a machine but not a port, so only the host is taken from the
  // request — `[::1]:4000` and `hub.local:4000` alike.
  const raw = hostHeader ?? '127.0.0.1';
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : (raw.split(':')[0] || '127.0.0.1');
  return `${https ? 'https' : 'http'}://${host}:${where.port}${base}`;
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
  /** Ports a preview may not ask for — the hub's own and the preview listener's. */
  reserved?: () => number[];
}

/** Carries the status the route should answer with. */
export class PreviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'PreviewError';
  }
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
  /**
   * The last config read from each manifest. The proxy needs the capability synchronously, for a
   * stopped preview as much as a running one, so it is cached here and warmed at boot.
   */
  private readonly configs = new Map<string, PreviewConfig>();
  /** One in-flight `start` per slug, so two concurrent callers can never orphan a child. */
  private readonly starting = new Map<string, Promise<PreviewSnapshot>>();
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

  /** The capability this project's preview is served under, from the cache the proxy reads. */
  capOf(slug: string): string | null {
    return this.configs.get(slug)?.cap ?? null;
  }

  /** Marks the project as in use, so the idle sweep leaves it alone. Called per proxied request. */
  touch(slug: string): void {
    const rec = this.running.get(slug);
    if (rec) rec.lastSeenAt = this.now();
  }

  /** Reads every project's preview config once, so a restarted hub can check capabilities. */
  async warm(): Promise<void> {
    for (const manifest of await this.deps.projects.list()) {
      if (manifest.preview?.cap) this.configs.set(manifest.slug, manifest.preview);
    }
  }

  async status(slug: string): Promise<PreviewSnapshot> {
    const config = await this.configFor(slug);
    const rec = this.running.get(slug);
    return {
      configured: !!config,
      running: !!rec,
      port: rec?.config.port ?? config?.port ?? null,
      base: config ? previewBase(slug, config.cap) : null,
      startedAt: rec?.startedAt ?? null,
      config: config ?? null,
      crashed: this.crashed.has(slug),
      log: (this.logs.get(slug) ?? []).slice(-LOG_TAIL),
    };
  }

  /**
   * Starts the project's dev server and waits for its port to answer. Idempotent, and serialized
   * per project: a second caller joins the first call's promise rather than spawning a second child
   * nothing would ever be able to stop. The wait is bounded — a server that is slow to bind still
   * counts as started, and its log tail is what says whether it is coming up or failing.
   */
  start(slug: string): Promise<PreviewSnapshot> {
    const inFlight = this.starting.get(slug);
    if (inFlight) return inFlight;
    const attempt = this.spawnPreview(slug).finally(() => { this.starting.delete(slug); });
    this.starting.set(slug, attempt);
    return attempt;
  }

  private async spawnPreview(slug: string): Promise<PreviewSnapshot> {
    if (this.running.has(slug)) return this.status(slug);
    const bundle = await this.deps.projects.get(slug);
    const config = await this.configFor(slug);
    if (!config) throw new PreviewError(400, 'this project has no preview configured');
    if ((this.deps.reserved?.() ?? []).includes(config.port)) {
      throw new PreviewError(400, `port ${config.port} is the hub's own; pick another`);
    }
    // Something already on the port would be proxied as if it were this project's app — which it
    // is not, and which the hub could not stop. That is a misconfiguration, not a fast start.
    if (await reachable(config.port)) {
      throw new PreviewError(409, `something is already listening on port ${config.port}`);
    }

    this.crashed.delete(slug);
    this.logs.set(slug, []);
    const [cmd, ...args] = config.cmd as [string, ...string[]];
    const child = spawn(cmd, args, {
      cwd: bundle.workspace,
      env: {
        ...secretsStripped(),
        PORT: String(config.port),
        // The one value a dev server's config has to agree with the hub about. Read it rather than
        // hard-code it: resetting the link mints a new capability, and with it a new base path.
        AGENTHUB_PREVIEW_BASE: previewBase(slug, config.cap),
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
    await this.awaitPort(slug, rec);
    return this.status(slug);
  }

  /** Stops the project's dev server, taking its whole process group with it. */
  async stop(slug: string): Promise<PreviewSnapshot> {
    const rec = this.running.get(slug);
    if (!rec) return this.status(slug);
    rec.stopping = true;
    this.running.delete(slug);
    if (this.running.size === 0) this.stopSweeping();
    await terminate(rec.child);
    return this.status(slug);
  }

  async restart(slug: string): Promise<PreviewSnapshot> {
    await this.stop(slug);
    return this.start(slug);
  }

  /** Records a config the owner (or an agent) just wrote, and stops whatever the old one started. */
  async adopt(slug: string, config: PreviewConfig | null): Promise<PreviewSnapshot> {
    if (config) this.configs.set(slug, config);
    else this.configs.delete(slug);
    await this.stop(slug);
    return this.status(slug);
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

  /**
   * The project's stored config, with two jobs beyond reading it. A preview saved before
   * capabilities existed is given one here rather than being left unreachable; and a config that
   * changed under a running preview — an agent's `set_preview`, a manifest edit, a revert — stops
   * it, so the next start is the command the manifest now names rather than the one it used to.
   */
  private async configFor(slug: string): Promise<PreviewConfig | null> {
    const bundle = await this.deps.projects.get(slug);
    let config = (await bundle.manifest()).preview ?? null;
    if (config && !CAP_RE.test(config.cap ?? '')) {
      config = { ...config, cap: newCapability() };
      await bundle.setPreview(config);
      await bundle.commit('hub: mint preview capability');
    }
    if (config) this.configs.set(slug, config);
    else this.configs.delete(slug);
    const rec = this.running.get(slug);
    if (rec && !sameConfig(rec.config, config)) await this.stop(slug);
    return config;
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

  /** Resolves once the port answers, the process dies or is replaced, or the wait runs out. */
  private async awaitPort(slug: string, rec: Running): Promise<void> {
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      // A command that could not be spawned at all (ENOENT) never exits — it errors — and a stop
      // racing the start drops the record. Either way this is no longer the preview we are waiting
      // for, and waiting on its port would be waiting on nothing.
      if (this.running.get(slug) !== rec) return;
      if (rec.child.exitCode !== null || rec.child.signalCode !== null) return;
      if (await reachable(rec.config.port)) return;
      if (this.now() >= deadline) return;
      await sleep(100);
    }
  }
}

/** Whether a running preview's command still matches what the manifest says. */
function sameConfig(a: PreviewConfig, b: PreviewConfig | null): boolean {
  return !!b && a.port === b.port && a.cap === b.cap && a.cmd.length === b.cmd.length
    && a.cmd.every((arg, i) => arg === b.cmd[i]);
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

/** A page for the iframe, in the two cases where there is no app to show. */
function placeholder(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Preview</title>` +
    `<body style="font:14px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#bbb">` +
    `<p>${message}</p></body>`;
}

/** The upstream request's headers: everything the browser sent, minus anything that authenticates. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  for (const name of STRIPPED_REQUEST_HEADERS) delete out[name];
  // The dev server is addressed on loopback and must see that, not the preview host — a Vite or
  // Next server checks Host against its own allow-list.
  out.host = `127.0.0.1:${port}`;
  return out;
}

/** The response headers that reach the browser: the upstream's, minus what belongs to the hop. */
export function downstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  for (const name of STRIPPED_RESPONSE_HEADERS) delete out[name];
  return out;
}

/**
 * The preview listener: one HTTP server that serves previews and nothing else.
 *
 * It is deliberately not a Fastify instance. There is no route here to add an API to by accident,
 * the upgrade is spliced at the TCP level rather than re-framed — so subprotocols, extensions,
 * close codes and reasons cross untouched — and the whole file can be read as what it is: a pipe
 * with a capability check at the mouth.
 */
export class PreviewServer {
  readonly server: Server;
  /** Sockets spliced to a dev server, so `close()` can drop them instead of hanging on them. */
  private readonly spliced = new Set<Socket>();

  constructor(private readonly supervisor: PreviewSupervisor) {
    this.server = createServer((req, res) => { this.onRequest(req, res); });
    this.server.on('upgrade', (req, socket, head) => { this.onUpgrade(req, socket as Socket, head); });
  }

  /** The port it ended up on — asked for after `listen`, because 0 means "anything free". */
  port(): number {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.spliced) socket.destroy();
    this.spliced.clear();
    return new Promise((resolve) => { this.server.close(() => resolve()); });
  }

  /** The slug a request may be proxied for, or null — which is every other request this port gets. */
  private resolve(url: string | undefined): { slug: string; cap: string; trailing: boolean } | null {
    const target = parsePreviewPath(url);
    if (!target) return null;
    const expected = this.supervisor.capOf(target.slug);
    // Constant-time, and the same answer either way: a wrong capability must not be a way to learn
    // which projects exist.
    if (!expected || !safeEqual(expected, target.cap)) return null;
    return target;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const target = this.resolve(req.url);
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(placeholder('Nothing here.'));
      return;
    }
    // `/p/<slug>/<cap>` addresses the app's root; without the slash every relative URL inside it
    // would resolve one segment too high.
    if (!target.trailing) {
      res.writeHead(301, { location: previewBase(target.slug, target.cap) });
      res.end();
      return;
    }
    const port = this.supervisor.portOf(target.slug);
    if (port === null) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(placeholder('This preview is not running.'));
      return;
    }
    this.supervisor.touch(target.slug);

    const upstream = httpRequest({
      host: '127.0.0.1', port, method: req.method, path: req.url,
      headers: upstreamHeaders(req.headers, port),
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, downstreamHeaders(up.headers));
      // A dev server that dies mid-response emits an error on a stream nobody is listening to,
      // which would take the hub down with it; `pipeline` turns that into one handled callback.
      pipeline(up, res, () => { res.destroy(); });
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(placeholder('The preview stopped answering.'));
    });
    res.on('close', () => { upstream.destroy(); });
    pipeline(req, upstream, (err) => { if (err) upstream.destroy(); });
  }

  /**
   * Hot reload. The upgrade is spliced rather than proxied: once the dev server has answered 101,
   * the two sockets are simply piped into each other, so every frame — including the close frame
   * with its code and reason — crosses exactly as it was sent.
   */
  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const target = this.resolve(req.url);
    const port = target ? this.supervisor.portOf(target.slug) : null;
    if (!target || port === null) {
      socket.destroy();
      return;
    }
    this.supervisor.touch(target.slug);
    // Nothing is read from the browser until there is somewhere to put it, so there is no buffer
    // here to grow: the kernel's receive window is the only backlog.
    socket.pause();
    const upstream = connect({ host: '127.0.0.1', port });
    this.spliced.add(socket);
    let settled = false;
    const drop = (): void => {
      settled = true;
      clearTimeout(timer);
      this.spliced.delete(socket);
      upstream.destroy();
      socket.destroy();
    };
    // A dev server that accepts the connection and then says nothing must not hold a socket open
    // for the rest of the hub's life.
    const timer = setTimeout(() => { if (!settled) drop(); }, UPGRADE_TIMEOUT_MS);
    timer.unref?.();

    upstream.on('connect', () => {
      settled = true;
      clearTimeout(timer);
      upstream.write(rawRequest(req, port));
      if (head.length) upstream.write(head);
      socket.resume();
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', drop);
    socket.on('error', drop);
    upstream.on('close', () => { this.spliced.delete(socket); socket.destroy(); });
    socket.on('close', () => { this.spliced.delete(socket); upstream.destroy(); });
  }
}

/**
 * The upgrade request, rebuilt for the dev server: the browser's own request line and headers in
 * the order they arrived, minus the credentials, with Host pointed at loopback. `rawHeaders` is
 * used rather than the parsed object so a repeated header is repeated and nothing is re-cased;
 * Node's parser has already refused anything with a newline in it.
 */
function rawRequest(req: IncomingMessage, port: number): string {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`, `host: 127.0.0.1:${port}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? '').toLowerCase();
    if (name === 'host' || STRIPPED_REQUEST_HEADERS.includes(name)) continue;
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1] ?? ''}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export interface PreviewRoutesOptions {
  projects: ProjectService;
  /** Re-reads the project list and broadcasts it, so a config change reaches the UI. */
  refresh?: () => Promise<void>;
  /** Where the preview listener binds, and the public origin it is reached at when there is one. */
  listen?: { port?: number; host?: string; publicBase?: string };
  now?: () => number;
  idleMs?: number;
  readyTimeoutMs?: number;
  /** Receives the supervisor and the listener once they are up, so tests can reach them. */
  onReady?: (parts: { supervisor: PreviewSupervisor; server: PreviewServer }) => void;
}

/**
 * The preview plugin: the owner's config and lifecycle routes under `/api/projects/:slug/preview`,
 * on the hub, and the separate preview listener that actually serves the app.
 */
export async function previewRoutes(app: FastifyInstance, opts: PreviewRoutesOptions): Promise<void> {
  const { projects } = opts;
  const hubPort = (): number => {
    const address = app.server.address();
    return address && typeof address === 'object' ? address.port : 0;
  };
  const supervisor = new PreviewSupervisor({
    projects,
    reserved: () => [hubPort(), server.port()].filter((port) => port > 0),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
  });
  const server = new PreviewServer(supervisor);
  await server.listen(opts.listen?.port ?? 0, opts.listen?.host ?? '0.0.0.0');
  // A hub that has just come up has never read a manifest, and the proxy checks capabilities
  // synchronously; without this the first preview request after a restart would 404.
  await supervisor.warm().catch((err: unknown) => app.log.error(`preview warm-up failed: ${(err as Error).message}`));
  opts.onReady?.({ supervisor, server });
  app.addHook('onClose', async () => {
    await server.close();
    await supervisor.stopAll();
  });

  /** The snapshot, plus the absolute address the browser should use for it. */
  const statusFor = async (slug: string, req: FastifyRequest): Promise<PreviewStatus> => {
    const snapshot = await supervisor.status(slug);
    const where = {
      ...(opts.listen?.publicBase ? { publicBase: opts.listen.publicBase } : {}),
      port: server.port(),
    };
    const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    return {
      ...snapshot,
      url: snapshot.config ? previewUrl(where, req.headers.host, https, slug, snapshot.config.cap) : null,
    };
  };

  /** Answers 400/404 the way every other project route does, and returns false once it has. */
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
    return statusFor(slug, req);
  });

  /** Saves the config and mints a capability; re-saving keeps the link the owner already has. */
  app.put('/api/projects/:slug/preview', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const validated = validatePreview(req.body);
    if ('error' in validated) return reply.code(400).send({ error: validated.error });
    if ([hubPort(), server.port()].includes(validated.preview.port)) {
      return reply.code(400).send({ error: `port ${validated.preview.port} is the hub's own; pick another` });
    }
    if (!(await resolve(slug, reply))) return reply;
    const bundle = await projects.get(slug);
    const current = (await bundle.manifest()).preview;
    const config: PreviewConfig = { ...validated.preview, cap: current?.cap ?? newCapability() };
    await bundle.setPreview(config);
    await bundle.commit('owner: set preview');
    await supervisor.adopt(slug, config);
    await opts.refresh?.();
    return statusFor(slug, req);
  });

  app.delete('/api/projects/:slug/preview', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolve(slug, reply))) return reply;
    const bundle = await projects.get(slug);
    await bundle.setPreview(undefined);
    await bundle.commit('owner: clear preview');
    await supervisor.adopt(slug, null);
    await opts.refresh?.();
    return statusFor(slug, req);
  });

  /**
   * A new capability — the "Reset link" button. The old address stops working immediately, and the
   * preview is stopped because the base path its dev server was started with has just changed.
   */
  app.post('/api/projects/:slug/preview/rotate', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolve(slug, reply))) return reply;
    const bundle = await projects.get(slug);
    const current = (await bundle.manifest()).preview;
    if (!current) return reply.code(400).send({ error: 'this project has no preview configured' });
    const config: PreviewConfig = { ...current, cap: newCapability() };
    await bundle.setPreview(config);
    await bundle.commit('owner: reset preview link');
    await supervisor.adopt(slug, config);
    await opts.refresh?.();
    return statusFor(slug, req);
  });

  const lifecycle: Record<string, (slug: string) => Promise<PreviewSnapshot>> = {
    start: (slug) => supervisor.start(slug),
    stop: (slug) => supervisor.stop(slug),
    restart: (slug) => supervisor.restart(slug),
  };
  for (const [action, apply] of Object.entries(lifecycle)) {
    app.post(`/api/projects/:slug/preview/${action}`, async (req, reply) => {
      const { slug } = req.params as { slug: string };
      if (!(await resolve(slug, reply))) return reply;
      try {
        await apply(slug);
        return await statusFor(slug, req);
      } catch (err) {
        if (err instanceof PreviewError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    });
  }
}
