// MUST stay the first import, as in main.ts: it silences simple-git's debug logging before
// simple-git is loaded. See debug-guard.ts.
import '../src/debug-guard.js';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockOpenAI, type MockOpenAI } from '@agenthub/mocks';
import type { NodeRegistration } from '@agenthub/shared';
import { createHub, type Hub } from '../src/server.js';
import { simRespond } from './agent-script.js';
import { seedProjects, type HubCall } from './seed.js';

/** The owner password every simulated hub uses. Not a secret: the sim only binds to this machine. */
export const SIM_PASSWORD = 'sim';
const SIM_SESSION_SECRET = 'agenthub-sim-session-secret';
const SIM_DAEMON_TOKEN = 'agenthub-sim-daemon-token';
/** The mock's endpoints are priced as these Fireworks models, so every cost surface shows dollars. */
const ORCHESTRATOR_MODEL = 'accounts/fireworks/models/glm-5p3';
const WORKER_MODEL = 'accounts/fireworks/models/glm-5p3-flash';
const HEARTBEAT_MS = 5000;

export interface SimOptions {
  /** Hub port; 0 picks a free one. Default 4100. */
  port?: number;
  /** Default 127.0.0.1: the sim has a fixed password and is never meant to be reachable from outside. */
  host?: string;
  /** Reuse this data directory; seeding is skipped when it already holds projects. Default: a fresh temp dir. */
  dataRoot?: string;
  /** Wipe `dataRoot` before starting. */
  reset?: boolean;
  /** The preview listener's port; 0 picks a free one. Default: hub port + 10, as the real hub does. */
  previewPort?: number;
  /** Per-token delay once seeding is done, so live turns visibly stream. Default 30 ms. */
  tokenDelayMs?: number;
  log?: (line: string) => void;
}

export interface Sim {
  url: string;
  password: string;
  dataRoot: string;
  /** One line per seeded project; empty when an existing `dataRoot` was reused. */
  seeded: string[];
  hub: Hub;
  mock: MockOpenAI;
  /** Stops the hub (and its previews and terminals), the mock and the heartbeat; removes a temp data dir. */
  stop(): Promise<void>;
}

/** A port nothing is listening on right now, for the preview's dev server when the hub's port is ephemeral. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));

/**
 * A whole AgentHub on this machine with nothing real behind it: the hub in-process with auth on,
 * the strict OpenAI mock answering as every agent (`agent-script.ts`), a mock node serving it, a
 * second node left to go stale, and three seeded projects. See docs/decisions for why it lives here.
 */
export async function startSim(opts: SimOptions = {}): Promise<Sim> {
  const log = opts.log ?? (() => {});
  const port = opts.port ?? 4100;
  const host = opts.host ?? '127.0.0.1';
  const tempRoot = !opts.dataRoot;
  const dataRoot = opts.dataRoot ?? await mkdtemp(join(tmpdir(), 'agenthub-sim-'));
  if (opts.reset && !tempRoot) await rm(dataRoot, { recursive: true, force: true });
  await mkdir(dataRoot, { recursive: true });

  const mock = createMockOpenAI({ respond: simRespond });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const mockUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  const hub = createHub({
    dbPath: join(dataRoot, 'hub.db'),
    projectsRoot: join(dataRoot, 'projects'),
    assistant: { memoryRoot: join(dataRoot, 'memory') },
    browser: { recordingsRoot: join(dataRoot, 'media', 'browser') },
    auth: { password: SIM_PASSWORD, sessionSecret: SIM_SESSION_SECRET, daemonToken: SIM_DAEMON_TOKEN },
    // Turns run when someone presses Run turn, never on a schedule nobody asked for.
    autoTurns: false,
    preview: { port: opts.previewPort ?? (port === 0 ? 0 : port + 10), host },
    ...(existsSync(UI_DIST) ? { uiDist: UI_DIST } : {}),
  });
  let heartbeat: NodeJS.Timeout | undefined;
  const stop = async (): Promise<void> => {
    clearInterval(heartbeat);
    await hub.stop();
    await mock.close();
    if (tempRoot) await rm(dataRoot, { recursive: true, force: true });
  };

  try {
    await hub.app.listen({ port, host });
    const address = hub.app.server.address() as { port: number };
    const url = `http://${host}:${address.port}`;

    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SIM_PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!login.ok || !cookie) throw new Error(`sim login failed: ${login.status}`);
    const request = async (method: string, path: string, body: unknown, auth: Record<string, string>): Promise<any> => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      return res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    };
    const call: HubCall = (method, path, body) => request(method, path, body, { cookie });
    const daemon: HubCall = (method, path, body) => request(method, path, body, { authorization: `Bearer ${SIM_DAEMON_TOKEN}` });

    const spark: NodeRegistration = {
      name: 'sim-spark', arch: 'arm64', jobTypes: ['shell-task'],
      endpoints: [
        { tier: 'orchestrator', provider: 'fireworks', url: mockUrl, model: ORCHESTRATOR_MODEL, maxStreams: 4 },
        { tier: 'worker', provider: 'fireworks', url: mockUrl, model: WORKER_MODEL, maxStreams: 8 },
      ],
    };
    await daemon('POST', '/api/nodes/register', spark);
    heartbeat = setInterval(() => {
      daemon('POST', '/api/nodes/sim-spark/heartbeat', {}).catch((err: unknown) => log(`[sim] heartbeat failed: ${String(err)}`));
    }, HEARTBEAT_MS);

    const fresh = (await readdir(join(dataRoot, 'projects')).catch(() => [])).length === 0;
    const previewAppPort = port === 0 ? await freePort() : port + 80;
    const seeded = fresh ? await seedProjects(call, hub, { previewAppPort }) : [];

    // Registered after seeding and never heard from again, so the Cluster page shows a node going
    // stale (offline ~15 s later). Its one endpoint is a tier no turn uses, so nothing routes to it.
    await daemon('POST', '/api/nodes/register', {
      name: 'sim-pc', arch: 'x64', jobTypes: ['shell-task'],
      endpoints: [{ tier: 'vision', url: 'http://127.0.0.1:9', model: 'qwen3-vl-8b', maxStreams: 1 }],
    } satisfies NodeRegistration);

    mock.setTokenDelay(opts.tokenDelayMs ?? 30);
    return { url, password: SIM_PASSWORD, dataRoot, seeded, hub, mock, stop };
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
}
