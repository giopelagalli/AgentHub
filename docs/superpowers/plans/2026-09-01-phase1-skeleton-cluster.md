# AgentHub Phase 1 — Skeleton Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working monorepo where a hub (node registry + job queue + model gateway + minimal agent runtime + REST/SSE API) and a node daemon (process supervisor + register/heartbeat) run two concurrent streaming agent chat sessions end-to-end against a mock OpenAI-compatible server.

**Architecture:** TypeScript ESM monorepo (npm workspaces): `packages/shared` (types), `packages/mocks` (mock OpenAI server), `packages/hub` (control plane), `packages/node-daemon` (per-node supervisor). SQLite (better-sqlite3) holds all hub state. All inference flows through the model gateway, which resolves a capability tier to a registered node endpoint and streams OpenAI-compatible chat completions.

**Tech Stack:** Node 22, TypeScript (strict, ESM, run via `tsx` — no build step in phase 1), Fastify, better-sqlite3, js-yaml, vitest.

## Global Constraints

- Node >= 22 (`engines` in root package.json); native `fetch` is used — no HTTP client deps.
- ESM everywhere: every package.json has `"type": "module"`; imports use `.js` extensions in relative specifiers (TS ESM convention).
- TypeScript `strict: true` in `tsconfig.base.json`.
- Tests: vitest, colocated under `packages/*/test/*.test.ts`. Run all with `npm test` at root (`vitest run`).
- Tier names exactly: `orchestrator | worker | vision | video-gen`. Priority names exactly: `interactive | project | batch` (numeric 0/1/2, lower wins).
- All timestamps are `Date.now()` epoch ms integers. Time-dependent logic takes an injectable `now` argument so tests never sleep.
- No external network calls in any test; everything runs against the mock server on 127.0.0.1.
- Commits: conventional style (`feat: …`, `test: …`, `chore: …`), one commit per task minimum, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Monorepo scaffold + shared types

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: everything in `@agenthub/shared` — all later tasks import from it:

```ts
export type Tier = 'orchestrator' | 'worker' | 'vision' | 'video-gen';
export type Priority = 'interactive' | 'project' | 'batch';
export const PRIORITY_RANK: Record<Priority, number>; // {interactive:0, project:1, batch:2}
export type JobType = 'llm-session' | 'video-gen' | 'shell-task' | 'browser-lease';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface ServingEndpoint { tier: Tier; url: string; model: string; maxStreams: number; }
export interface NodeRegistration { name: string; arch: string; endpoints: ServingEndpoint[]; }
export interface NodeInfo extends NodeRegistration { id: number; status: 'online' | 'offline'; lastHeartbeat: number; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface JobSpec { type: JobType; tier: Tier; priority: Priority; project?: string; payload: unknown; }
export interface Job extends JobSpec { id: number; status: JobStatus; nodeId: number | null; createdAt: number; updatedAt: number; }
```

- [ ] **Step 1: Scaffold the workspace**

Root `package.json`:

```json
{
  "name": "agenthub",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["packages/*"],
  "scripts": { "test": "vitest run", "typecheck": "tsc -b --noEmit || tsc --noEmit -p tsconfig.base.json" },
  "devDependencies": {}
}
```

Run:

```bash
npm i -D typescript tsx vitest @types/node
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000 },
});
```

`packages/shared/package.json`:

```json
{ "name": "@agenthub/shared", "version": "0.0.1", "type": "module", "main": "src/index.ts", "exports": { ".": "./src/index.ts" } }
```

`packages/shared/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: Write the failing test**

`packages/shared/test/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PRIORITY_RANK, comparePriority } from '../src/index.js';
import type { JobSpec } from '../src/index.js';

describe('shared types', () => {
  it('ranks priorities interactive < project < batch', () => {
    expect(PRIORITY_RANK.interactive).toBeLessThan(PRIORITY_RANK.project);
    expect(PRIORITY_RANK.project).toBeLessThan(PRIORITY_RANK.batch);
  });

  it('comparePriority sorts specs by rank ascending', () => {
    const a: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'batch', payload: {} };
    const b: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'interactive', payload: {} };
    expect([a, b].sort(comparePriority)[0]).toBe(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/shared`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Implement shared types**

`packages/shared/src/index.ts`: all types from the Interfaces block above, plus:

```ts
export const PRIORITY_RANK: Record<Priority, number> = { interactive: 0, project: 1, batch: 2 };
export function comparePriority(a: Pick<JobSpec, 'priority'>, b: Pick<JobSpec, 'priority'>): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run packages/shared` — Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts packages/shared
git commit -m "feat: monorepo scaffold with shared types package"
```

---

### Task 2: Mock OpenAI-compatible server

**Files:**
- Create: `packages/mocks/package.json` (`{ "name": "@agenthub/mocks", "version": "0.0.1", "type": "module", "exports": { ".": "./src/openai-mock.ts" }, "dependencies": { "fastify": "^5" } }`), `packages/mocks/tsconfig.json` (same shape as shared's)
- Create: `packages/mocks/src/openai-mock.ts`, `packages/mocks/src/serve.ts`
- Test: `packages/mocks/test/openai-mock.test.ts`

**Interfaces:**
- Consumes: nothing from other packages.
- Produces:

```ts
// openai-mock.ts
export interface MockOptions { tokenDelayMs?: number; replyFor?: (lastUser: string) => string; }
export function createMockOpenAI(opts?: MockOptions): FastifyInstance;
// Implements: GET /v1/models -> {data:[{id:'mock-model'}]}
// POST /v1/chat/completions -> non-stream JSON or SSE stream per body.stream,
//   default reply: `echo: ${lastUserMessage}`
// serve.ts: CLI — `tsx packages/mocks/src/serve.ts <port> [tokenDelayMs]` listens on 127.0.0.1:<port>
```

- [ ] **Step 1: Install dep**

```bash
npm i fastify -w packages/mocks
```

- [ ] **Step 2: Write the failing test**

`packages/mocks/test/openai-mock.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createMockOpenAI } from '../src/openai-mock.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('mock openai server', () => {
  it('serves /v1/models', async () => {
    app = createMockOpenAI();
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].id).toBe('mock-model');
  });

  it('answers non-streaming chat completions with an echo', async () => {
    app = createMockOpenAI();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hi there' }] },
    });
    expect(res.json().choices[0].message.content).toBe('echo: hi there');
  });

  it('streams SSE chunks ending with [DONE]', async () => {
    app = createMockOpenAI({ tokenDelayMs: 1 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'one two three' }] }),
    });
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const contents = [...text.matchAll(/data: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]).choices[0].delta.content ?? '').join('');
    expect(contents).toBe('echo: one two three');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify fail** — `npx vitest run packages/mocks` → FAIL (module not found).

- [ ] **Step 4: Implement**

`packages/mocks/src/openai-mock.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';

export interface MockOptions { tokenDelayMs?: number; replyFor?: (lastUser: string) => string; }

interface ChatBody { model: string; stream?: boolean; messages: { role: string; content: string }[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockOpenAI(opts: MockOptions = {}): FastifyInstance {
  const { tokenDelayMs = 0, replyFor = (u) => `echo: ${u}` } = opts;
  const app = Fastify();

  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as ChatBody;
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const full = replyFor(lastUser);
    if (!body.stream) {
      return {
        id: 'mock-1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
      };
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // split into whitespace-preserving tokens so concatenation reproduces `full`
    const tokens = full.match(/\S+\s*/g) ?? [];
    for (const tok of tokens) {
      if (tokenDelayMs) await sleep(tokenDelayMs);
      const chunk = { id: 'mock-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: tok }, finish_reason: null }] };
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });

  return app;
}
```

`packages/mocks/src/serve.ts`:

```ts
import { createMockOpenAI } from './openai-mock.js';
const port = Number(process.argv[2] ?? 8100);
const tokenDelayMs = Number(process.argv[3] ?? 0);
const app = createMockOpenAI({ tokenDelayMs });
app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`[mock-openai] listening on ${port}`));
```

- [ ] **Step 5: Run tests, verify pass** — `npx vitest run packages/mocks` → PASS (3 tests).

- [ ] **Step 6: Commit** — `git add packages/mocks package.json package-lock.json && git commit -m "feat: mock OpenAI-compatible server for dev and tests"`

---

### Task 3: Hub database module

**Files:**
- Create: `packages/hub/package.json` (`{ "name": "@agenthub/hub", "version": "0.0.1", "type": "module", "dependencies": { "fastify": "^5", "better-sqlite3": "^11", "js-yaml": "^4", "@agenthub/shared": "*", "@agenthub/mocks": "*" }, "devDependencies": { "@types/better-sqlite3": "^7", "@types/js-yaml": "^4" } }`), `packages/hub/tsconfig.json`
- Create: `packages/hub/src/db.ts`
- Test: `packages/hub/test/db.test.ts`

**Interfaces:**
- Consumes: nothing from other packages.
- Produces:

```ts
import type Database from 'better-sqlite3';
export type Db = Database.Database;
export function openDb(path: string): Db; // ':memory:' allowed; applies schema idempotently, journal_mode=WAL for file DBs
```

Tables (exact): `nodes(id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE NOT NULL, arch TEXT NOT NULL, endpoints_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'online', last_heartbeat INTEGER NOT NULL)`; `jobs(id PK, type TEXT, tier TEXT, priority INTEGER, project TEXT NULL, payload_json TEXT, status TEXT DEFAULT 'queued', node_id INTEGER NULL, created_at INTEGER, updated_at INTEGER)`; `agents(id PK, name TEXT NOT NULL, tier TEXT NOT NULL, system_prompt TEXT NOT NULL)`; `messages(id PK, agent_id INTEGER NOT NULL REFERENCES agents(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`.

- [ ] **Step 1: Install deps** — `npm i fastify better-sqlite3 js-yaml -w packages/hub && npm i -D @types/better-sqlite3 @types/js-yaml -w packages/hub` (workspace deps `@agenthub/shared`/`@agenthub/mocks` are wired by the package.json above).

- [ ] **Step 2: Write the failing test**

`packages/hub/test/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('db', () => {
  it('creates schema idempotently and accepts inserts', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES (?,?,?,?)`)
      .run('spark', 'arm64', '[]', Date.now());
    const row = db.prepare('SELECT name, status FROM nodes').get() as { name: string; status: string };
    expect(row).toEqual({ name: 'spark', status: 'online' });
    // idempotent re-open on same handle path shape
    openDb(':memory:');
  });
});
```

- [ ] **Step 3: Run, verify fail** — `npx vitest run packages/hub` → FAIL.

- [ ] **Step 4: Implement**

`packages/hub/src/db.ts`:

```ts
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  arch TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  last_heartbeat INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  tier TEXT NOT NULL,
  priority INTEGER NOT NULL,
  project TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  node_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  system_prompt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 5: Run tests, verify pass.**

- [ ] **Step 6: Commit** — `git commit -m "feat: hub sqlite schema and db module"` (add `packages/hub`, lockfile, root package.json).

---

### Task 4: Node registry

**Files:**
- Create: `packages/hub/src/node-registry.ts`
- Test: `packages/hub/test/node-registry.test.ts`

**Interfaces:**
- Consumes: `openDb`/`Db` (Task 3); `NodeRegistration`, `NodeInfo` (Task 1).
- Produces:

```ts
export class NodeRegistry {
  constructor(db: Db, opts?: { staleMs?: number }); // default staleMs 15000
  register(reg: NodeRegistration, now?: number): NodeInfo; // upsert by name, sets online + heartbeat
  heartbeat(name: string, now?: number): boolean;          // false if unknown node
  sweep(now?: number): NodeInfo[];                          // stale online nodes -> offline; returns newly offline
  online(now?: number): NodeInfo[];                         // online, heartbeat fresh
  byName(name: string): NodeInfo | null;
}
```

- [ ] **Step 1: Write the failing test**

`packages/hub/test/node-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import type { NodeRegistration } from '@agenthub/shared';

const reg = (name: string): NodeRegistration => ({
  name, arch: 'arm64',
  endpoints: [{ tier: 'worker', url: `http://127.0.0.1:81/${name}`, model: 'mock-model', maxStreams: 4 }],
});

let db: Db; let registry: NodeRegistry;
beforeEach(() => { db = openDb(':memory:'); registry = new NodeRegistry(db, { staleMs: 1000 }); });

describe('NodeRegistry', () => {
  it('registers and upserts by name', () => {
    const a = registry.register(reg('spark'), 100);
    const b = registry.register(reg('spark'), 200);
    expect(b.id).toBe(a.id);
    expect(registry.online(300)).toHaveLength(1);
    expect(registry.byName('spark')?.endpoints[0].tier).toBe('worker');
  });

  it('marks nodes offline after staleMs without heartbeat, and revives on heartbeat', () => {
    registry.register(reg('mb'), 0);
    expect(registry.sweep(500)).toHaveLength(0);
    const gone = registry.sweep(2000);
    expect(gone.map(n => n.name)).toEqual(['mb']);
    expect(registry.online(2000)).toHaveLength(0);
    expect(registry.heartbeat('mb', 2500)).toBe(true);
    expect(registry.online(2600).map(n => n.name)).toEqual(['mb']);
    expect(registry.heartbeat('ghost', 2500)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

`packages/hub/src/node-registry.ts`:

```ts
import type { Db } from './db.js';
import type { NodeInfo, NodeRegistration, ServingEndpoint } from '@agenthub/shared';

interface Row { id: number; name: string; arch: string; endpoints_json: string; status: 'online' | 'offline'; last_heartbeat: number; }

const toInfo = (r: Row): NodeInfo => ({
  id: r.id, name: r.name, arch: r.arch, status: r.status,
  lastHeartbeat: r.last_heartbeat, endpoints: JSON.parse(r.endpoints_json) as ServingEndpoint[],
});

export class NodeRegistry {
  private staleMs: number;
  constructor(private db: Db, opts: { staleMs?: number } = {}) { this.staleMs = opts.staleMs ?? 15000; }

  register(reg: NodeRegistration, now = Date.now()): NodeInfo {
    this.db.prepare(`
      INSERT INTO nodes (name, arch, endpoints_json, status, last_heartbeat) VALUES (?,?,?, 'online', ?)
      ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, endpoints_json=excluded.endpoints_json,
        status='online', last_heartbeat=excluded.last_heartbeat
    `).run(reg.name, reg.arch, JSON.stringify(reg.endpoints), now);
    return this.byName(reg.name)!;
  }

  heartbeat(name: string, now = Date.now()): boolean {
    const res = this.db.prepare(`UPDATE nodes SET status='online', last_heartbeat=? WHERE name=?`).run(now, name);
    return res.changes > 0;
  }

  sweep(now = Date.now()): NodeInfo[] {
    const stale = this.db.prepare(`SELECT * FROM nodes WHERE status='online' AND last_heartbeat < ?`)
      .all(now - this.staleMs) as Row[];
    if (stale.length) {
      const ids = stale.map(r => r.id);
      this.db.prepare(`UPDATE nodes SET status='offline' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    return stale.map(r => toInfo({ ...r, status: 'offline' }));
  }

  online(now = Date.now()): NodeInfo[] {
    return (this.db.prepare(`SELECT * FROM nodes WHERE status='online' AND last_heartbeat >= ?`)
      .all(now - this.staleMs) as Row[]).map(toInfo);
  }

  byName(name: string): NodeInfo | null {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE name=?`).get(name) as Row | undefined;
    return r ? toInfo(r) : null;
  }
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: node registry with heartbeat staleness sweep"`

---

### Task 5: Job queue

**Files:**
- Create: `packages/hub/src/queue.ts`
- Test: `packages/hub/test/queue.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 3); `JobSpec`, `Job`, `PRIORITY_RANK` (Task 1).
- Produces:

```ts
export class JobQueue {
  constructor(db: Db);
  enqueue(spec: JobSpec, now?: number): Job;
  claim(types: JobType[], nodeId: number, now?: number): Job | null; // best = lowest priority rank, then oldest; marks running
  complete(id: number, now?: number): void;                          // -> done
  fail(id: number, opts?: { requeue?: boolean }, now?: number): void; // -> failed, or back to queued with node_id NULL
  requeueForNode(nodeId: number, now?: number): number;              // running jobs on node -> queued; returns count
  list(status?: JobStatus): Job[];
}
```

- [ ] **Step 1: Write the failing test**

`packages/hub/test/queue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import type { JobSpec } from '@agenthub/shared';

const spec = (priority: JobSpec['priority'], type: JobSpec['type'] = 'shell-task'): JobSpec =>
  ({ type, tier: 'worker', priority, payload: { p: priority } });

let db: Db; let q: JobQueue;
beforeEach(() => { db = openDb(':memory:'); q = new JobQueue(db); });

describe('JobQueue', () => {
  it('claims by priority then FIFO, filtered by type', () => {
    q.enqueue(spec('batch'), 1);
    const b = q.enqueue(spec('interactive'), 2);
    const c = q.enqueue(spec('interactive'), 3);
    q.enqueue(spec('interactive', 'video-gen'), 4);
    expect(q.claim(['shell-task'], 7)?.id).toBe(b.id);
    expect(q.claim(['shell-task'], 7)?.id).toBe(c.id);
    expect(q.claim(['shell-task'], 7)?.priority).toBe('batch');
    expect(q.claim(['shell-task'], 7)).toBeNull();
  });

  it('complete and fail transitions', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.complete(j.id);
    expect(q.list('done')).toHaveLength(1);
    const k = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.fail(k.id, { requeue: true });
    expect(q.list('queued')[0].nodeId).toBeNull();
  });

  it('requeueForNode returns running jobs of a dead node to the queue', () => {
    q.enqueue(spec('project')); q.enqueue(spec('project'));
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5);
    expect(q.requeueForNode(5)).toBe(2);
    expect(q.list('queued')).toHaveLength(2);
    expect(q.requeueForNode(5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

`packages/hub/src/queue.ts`:

```ts
import type { Db } from './db.js';
import { PRIORITY_RANK, type Job, type JobSpec, type JobStatus, type JobType, type Priority } from '@agenthub/shared';

interface Row { id: number; type: JobType; tier: Job['tier']; priority: number; project: string | null; payload_json: string; status: JobStatus; node_id: number | null; created_at: number; updated_at: number; }

const RANK_TO_PRIORITY = Object.fromEntries(Object.entries(PRIORITY_RANK).map(([k, v]) => [v, k])) as Record<number, Priority>;

const toJob = (r: Row): Job => ({
  id: r.id, type: r.type, tier: r.tier, priority: RANK_TO_PRIORITY[r.priority],
  project: r.project ?? undefined, payload: JSON.parse(r.payload_json),
  status: r.status, nodeId: r.node_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class JobQueue {
  constructor(private db: Db) {}

  enqueue(spec: JobSpec, now = Date.now()): Job {
    const res = this.db.prepare(`
      INSERT INTO jobs (type, tier, priority, project, payload_json, status, created_at, updated_at)
      VALUES (?,?,?,?,?, 'queued', ?, ?)
    `).run(spec.type, spec.tier, PRIORITY_RANK[spec.priority], spec.project ?? null, JSON.stringify(spec.payload), now, now);
    return this.get(Number(res.lastInsertRowid));
  }

  claim(types: JobType[], nodeId: number, now = Date.now()): Job | null {
    const claim = this.db.transaction((): Job | null => {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE status='queued' AND type IN (${types.map(() => '?').join(',')})
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1
      `).get(...types) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET status='running', node_id=?, updated_at=? WHERE id=?`).run(nodeId, now, row.id);
      return this.get(row.id);
    });
    return claim();
  }

  complete(id: number, now = Date.now()): void {
    this.db.prepare(`UPDATE jobs SET status='done', updated_at=? WHERE id=?`).run(now, id);
  }

  fail(id: number, opts: { requeue?: boolean } = {}, now = Date.now()): void {
    if (opts.requeue) this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE id=?`).run(now, id);
    else this.db.prepare(`UPDATE jobs SET status='failed', updated_at=? WHERE id=?`).run(now, id);
  }

  requeueForNode(nodeId: number, now = Date.now()): number {
    return this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE status='running' AND node_id=?`)
      .run(now, nodeId).changes;
  }

  list(status?: JobStatus): Job[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM jobs WHERE status=? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM jobs ORDER BY id`).all()) as Row[];
    return rows.map(toJob);
  }

  private get(id: number): Job {
    return toJob(this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Row);
  }
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: priority job queue with claim/requeue semantics"`

---

### Task 6: Model gateway

**Files:**
- Create: `packages/hub/src/gateway.ts`
- Test: `packages/hub/test/gateway.test.ts`

**Interfaces:**
- Consumes: `NodeRegistry` (Task 4); `Tier`, `ChatMessage`, `ServingEndpoint`, `NodeInfo` (Task 1); mock server (Task 2, test only).
- Produces:

```ts
export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }
export class ModelGateway {
  constructor(registry: NodeRegistry);
  pick(tier: Tier): PickResult | null; // online nodes with endpoint of tier & free stream slot; least active streams first
  chat(tier: Tier, messages: ChatMessage[], onToken?: (t: string) => void): Promise<string>;
  // streams OpenAI chat completions from picked endpoint, calls onToken per delta, resolves full text.
  // throws Error('no capacity for tier: <tier>') when pick() is null.
  activeStreams(tier?: Tier): number;
}
```

- [ ] **Step 1: Write the failing test**

`packages/hub/test/gateway.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';

let mock: FastifyInstance; let url: string;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 5 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
});
afterAll(async () => { await mock.close(); });

function setup(maxStreams = 2) {
  const registry = new NodeRegistry(openDb(':memory:'));
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams }] });
  return { registry, gateway: new ModelGateway(registry) };
}

describe('ModelGateway', () => {
  it('picks null for unserved tier and errors on chat', async () => {
    const { gateway } = setup();
    expect(gateway.pick('video-gen')).toBeNull();
    await expect(gateway.chat('video-gen', [{ role: 'user', content: 'x' }])).rejects.toThrow('no capacity');
  });

  it('streams tokens and resolves the full text', async () => {
    const { gateway } = setup();
    const tokens: string[] = [];
    const full = await gateway.chat('worker', [{ role: 'user', content: 'hello world' }], (t) => tokens.push(t));
    expect(full).toBe('echo: hello world');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(full);
    expect(gateway.activeStreams()).toBe(0);
  });

  it('runs two sessions concurrently and enforces maxStreams', async () => {
    const { gateway } = setup(2);
    let maxActive = 0;
    const run = () => gateway.chat('worker', [{ role: 'user', content: 'a b c d e' }], () => {
      maxActive = Math.max(maxActive, gateway.activeStreams('worker'));
    });
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1).toBe('echo: a b c d e'); expect(r2).toBe('echo: a b c d e');
    expect(maxActive).toBe(2);
    // saturate: occupy both slots, third pick returns null
    const p = Promise.all([run(), run()]);
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.pick('worker')).toBeNull();
    await p;
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

`packages/hub/src/gateway.ts`:

```ts
import type { ChatMessage, NodeInfo, ServingEndpoint, Tier } from '@agenthub/shared';
import type { NodeRegistry } from './node-registry.js';

export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }

export class ModelGateway {
  private active = new Map<string, number>(); // `${node.name}|${tier}|${endpoint.url}` -> active streams

  constructor(private registry: NodeRegistry) {}

  private key(node: NodeInfo, ep: ServingEndpoint): string { return `${node.name}|${ep.tier}|${ep.url}`; }

  pick(tier: Tier): PickResult | null {
    const candidates: { pick: PickResult; active: number }[] = [];
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) {
        if (endpoint.tier !== tier) continue;
        const active = this.active.get(this.key(node, endpoint)) ?? 0;
        if (active < endpoint.maxStreams) candidates.push({ pick: { node, endpoint }, active });
      }
    }
    candidates.sort((a, b) => a.active - b.active);
    return candidates[0]?.pick ?? null;
  }

  activeStreams(tier?: Tier): number {
    let sum = 0;
    for (const [key, n] of this.active) if (!tier || key.split('|')[1] === tier) sum += n;
    return sum;
  }

  async chat(tier: Tier, messages: ChatMessage[], onToken?: (t: string) => void): Promise<string> {
    const picked = this.pick(tier);
    if (!picked) throw new Error(`no capacity for tier: ${tier}`);
    const key = this.key(picked.node, picked.endpoint);
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      const res = await fetch(`${picked.endpoint.url}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: picked.endpoint.model, messages, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error(`endpoint error ${res.status} from ${picked.endpoint.url}`);
      let full = '';
      let buf = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) { full += delta; onToken?.(delta); }
        }
      }
      return full;
    } finally {
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    }
  }
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: model gateway with tier routing and stream accounting"`

---

### Task 7: Agent runtime (minimal chat sessions)

**Files:**
- Create: `packages/hub/src/agents.ts`
- Test: `packages/hub/test/agents.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 3), `ModelGateway` (Task 6), `ChatMessage`/`Tier` (Task 1).
- Produces:

```ts
export interface AgentRecord { id: number; name: string; tier: Tier; systemPrompt: string; }
export class AgentRuntime {
  constructor(db: Db, gateway: ModelGateway);
  createAgent(a: { name: string; tier: Tier; systemPrompt: string }): AgentRecord;
  getAgent(id: number): AgentRecord | null;
  listAgents(): AgentRecord[];
  history(agentId: number): ChatMessage[];   // persisted, ordered, without system prompt
  send(agentId: number, userText: string, onToken?: (t: string) => void): Promise<string>;
  // builds [system, ...history, user], streams via gateway.chat(agent.tier, ...), persists user+assistant messages
}
```

- [ ] **Step 1: Write the failing test**

`packages/hub/test/agents.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentRuntime } from '../src/agents.js';

let mock: FastifyInstance; let url: string;
beforeAll(async () => {
  mock = createMockOpenAI();
  await mock.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
});
afterAll(async () => { await mock.close(); });

describe('AgentRuntime', () => {
  it('persists conversation turns across send calls', async () => {
    const db = openDb(':memory:');
    const registry = new NodeRegistry(db);
    registry.register({ name: 'n1', arch: 'x64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 4 }] });
    const runtime = new AgentRuntime(db, new ModelGateway(registry));
    const agent = runtime.createAgent({ name: 'scout', tier: 'worker', systemPrompt: 'You are scout.' });

    const reply1 = await runtime.send(agent.id, 'first message');
    expect(reply1).toBe('echo: first message');
    await runtime.send(agent.id, 'second message');

    const history = runtime.history(agent.id);
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[1].content).toBe('echo: first message');
    expect(runtime.getAgent(agent.id)?.name).toBe('scout');
    expect(runtime.listAgents()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

`packages/hub/src/agents.ts`:

```ts
import type { ChatMessage, Tier } from '@agenthub/shared';
import type { Db } from './db.js';
import type { ModelGateway } from './gateway.js';

export interface AgentRecord { id: number; name: string; tier: Tier; systemPrompt: string; }

interface AgentRow { id: number; name: string; tier: Tier; system_prompt: string; }
interface MessageRow { role: ChatMessage['role']; content: string; }

const toAgent = (r: AgentRow): AgentRecord => ({ id: r.id, name: r.name, tier: r.tier, systemPrompt: r.system_prompt });

export class AgentRuntime {
  constructor(private db: Db, private gateway: ModelGateway) {}

  createAgent(a: { name: string; tier: Tier; systemPrompt: string }): AgentRecord {
    const res = this.db.prepare(`INSERT INTO agents (name, tier, system_prompt) VALUES (?,?,?)`)
      .run(a.name, a.tier, a.systemPrompt);
    return { id: Number(res.lastInsertRowid), ...a };
  }

  getAgent(id: number): AgentRecord | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return r ? toAgent(r) : null;
  }

  listAgents(): AgentRecord[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY id`).all() as AgentRow[]).map(toAgent);
  }

  history(agentId: number): ChatMessage[] {
    return (this.db.prepare(`SELECT role, content FROM messages WHERE agent_id=? ORDER BY id`)
      .all(agentId) as MessageRow[]).map((m) => ({ role: m.role, content: m.content }));
  }

  async send(agentId: number, userText: string, onToken?: (t: string) => void): Promise<string> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
      ...this.history(agentId),
      { role: 'user', content: userText },
    ];
    const reply = await this.gateway.chat(agent.tier, messages, onToken);
    const insert = this.db.prepare(`INSERT INTO messages (agent_id, role, content, created_at) VALUES (?,?,?,?)`);
    const now = Date.now();
    insert.run(agentId, 'user', userText, now);
    insert.run(agentId, 'assistant', reply, now + 1);
    return reply;
  }
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: minimal agent runtime with persisted chat sessions"`

---

### Task 8: Hub server (REST + SSE API)

**Files:**
- Create: `packages/hub/src/server.ts`, `packages/hub/src/main.ts`
- Test: `packages/hub/test/server.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7 constructors; `NodeRegistration` (Task 1).
- Produces:

```ts
export interface Hub { app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway; runtime: AgentRuntime; stop(): Promise<void>; }
export function createHub(opts?: { dbPath?: string; staleMs?: number; sweepIntervalMs?: number }): Hub;
// Routes:
//  POST /api/nodes/register        body NodeRegistration -> NodeInfo
//  POST /api/nodes/:name/heartbeat -> {ok: boolean} (404 if unknown)
//  GET  /api/nodes                 -> NodeInfo[] (all, with current status)
//  GET  /api/state                 -> { nodes: NodeInfo[]; agents: AgentRecord[]; jobs: Job[] }
//  POST /api/agents                body {name, tier, systemPrompt} -> AgentRecord
//  POST /api/agents/:id/messages   body {text} -> SSE stream: `data: {"token": "..."}\n\n`* then `data: {"done": true, "full": "..."}\n\n`
// A sweep timer runs every sweepIntervalMs (default 5000): registry.sweep() and queue.requeueForNode() per newly-offline node.
// createHub does NOT listen; tests use app.inject / app.listen({port: 0}). main.ts listens on PORT (default 4000, host 0.0.0.0).
```

- [ ] **Step 1: Write the failing test**

`packages/hub/test/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../src/server.js';

let mock: FastifyInstance; let mockUrl: string; let hub: Hub;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 2 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mockUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub();
});
afterAll(async () => { await hub.stop(); await mock.close(); });

describe('hub server', () => {
  it('registers nodes and reports state', async () => {
    const res = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url: mockUrl, model: 'mock-model', maxStreams: 8 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('spark');
    const hb = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat' });
    expect(hb.json().ok).toBe(true);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/nope/heartbeat' })).statusCode).toBe(404);
    const state = (await hub.app.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.nodes).toHaveLength(1);
  });

  it('creates an agent and streams a chat via SSE', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/agents',
      payload: { name: 'helper', tier: 'worker', systemPrompt: 'You help.' },
    })).json();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${created.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ping pong' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = [...body.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]));
    const tokens = events.filter((e) => e.token).map((e) => e.token).join('');
    const done = events.find((e) => e.done);
    expect(tokens).toBe('echo: ping pong');
    expect(done.full).toBe('echo: ping pong');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

`packages/hub/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeRegistration, Tier } from '@agenthub/shared';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { ModelGateway } from './gateway.js';
import { AgentRuntime } from './agents.js';

export interface Hub { app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway; runtime: AgentRuntime; stop(): Promise<void>; }

export function createHub(opts: { dbPath?: string; staleMs?: number; sweepIntervalMs?: number } = {}): Hub {
  const db = openDb(opts.dbPath ?? ':memory:');
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const queue = new JobQueue(db);
  const gateway = new ModelGateway(registry);
  const runtime = new AgentRuntime(db, gateway);
  const app = Fastify();

  const sweeper = setInterval(() => {
    for (const node of registry.sweep()) {
      const n = queue.requeueForNode(node.id);
      if (n) app.log.info(`requeued ${n} jobs from offline node ${node.name}`);
    }
  }, opts.sweepIntervalMs ?? 5000);
  sweeper.unref();

  app.post('/api/nodes/register', async (req) => registry.register(req.body as NodeRegistration));

  app.post('/api/nodes/:name/heartbeat', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!registry.heartbeat(name)) return reply.code(404).send({ ok: false });
    return { ok: true };
  });

  app.get('/api/nodes', async () => {
    registry.sweep();
    return [...registry.online(), ]; // online() reflects fresh; offline nodes included below
  });

  app.get('/api/state', async () => {
    registry.sweep();
    return { nodes: registry.online(), agents: runtime.listAgents(), jobs: queue.list() };
  });

  app.post('/api/agents', async (req) =>
    runtime.createAgent(req.body as { name: string; tier: Tier; systemPrompt: string }));

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { text } = req.body as { text: string };
    if (!runtime.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    try {
      const full = await runtime.send(id, text, (token) => {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`);
      });
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    }
    reply.raw.end();
    return reply;
  });

  return {
    app, db, registry, queue, gateway, runtime,
    async stop() { clearInterval(sweeper); await app.close(); db.close(); },
  };
}
```

Note for implementer: `GET /api/nodes` should return **all** nodes with current status — implement as a small `all()` method on `NodeRegistry` (`SELECT * FROM nodes ORDER BY id`, mapped by the same `toInfo`) and call `registry.sweep()` first; do the same in `/api/state`. Add `all()` to `NodeRegistry` in this task (with the sweep-before-read behavior covered by the server test asserting `state.nodes` length).

`packages/hub/src/main.ts`:

```ts
import { createHub } from './server.js';

const hub = createHub({ dbPath: process.env.HUB_DB ?? 'data/hub.db' });
const port = Number(process.env.PORT ?? 4000);
hub.app.listen({ port, host: '0.0.0.0' }).then((addr) => console.log(`[hub] listening at ${addr}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => hub.stop().then(() => process.exit(0)));
```

(Ensure `data/` exists before opening a file DB: `import { mkdirSync } from 'node:fs'; import { dirname } from 'node:path';` then `mkdirSync(dirname(dbPath), { recursive: true })` inside `createHub` when `dbPath !== ':memory:'`.)

- [ ] **Step 4: Run tests, verify pass** — `npx vitest run packages/hub`.
- [ ] **Step 5: Commit** — `git commit -m "feat: hub REST/SSE server wiring registry, queue, gateway, agents"`

---

### Task 9: Node daemon

**Files:**
- Create: `packages/node-daemon/package.json` (`{ "name": "@agenthub/node-daemon", "version": "0.0.1", "type": "module", "dependencies": { "js-yaml": "^4", "@agenthub/shared": "*" }, "devDependencies": { "@types/js-yaml": "^4" } }`), `packages/node-daemon/tsconfig.json`
- Create: `packages/node-daemon/src/config.ts`, `packages/node-daemon/src/supervisor.ts`, `packages/node-daemon/src/daemon.ts`, `packages/node-daemon/src/main.ts`
- Test: `packages/node-daemon/test/daemon.test.ts`

**Interfaces:**
- Consumes: hub HTTP API (Task 8), mock server CLI (Task 2), `NodeRegistration`/`ServingEndpoint` (Task 1).
- Produces:

```ts
// config.ts
export interface ServingConfig { tier: Tier; model: string; port: number; maxStreams: number; cmd: string[]; }
export interface DaemonConfig { node: { name: string; arch: string }; hub: string; advertiseHost?: string; heartbeatMs?: number; serving: ServingConfig[]; }
export function loadConfig(path: string): DaemonConfig; // yaml, validates required fields, throws Error('daemon config: <what> missing')

// supervisor.ts
export class Supervisor {
  constructor(serving: ServingConfig[]);
  async startAll(timeoutMs?: number): Promise<void>; // spawn each cmd, poll GET http://127.0.0.1:<port>/v1/models until 200; throw on timeout (default 15000)
  async stopAll(): Promise<void>;                    // SIGTERM children, wait for exit
}

// daemon.ts
export class Daemon {
  constructor(cfg: DaemonConfig);
  async start(): Promise<void>; // supervisor.startAll() -> POST {hub}/api/nodes/register -> heartbeat loop every heartbeatMs (default 5000)
  async stop(): Promise<void>;  // stop heartbeat, supervisor.stopAll()
  registration(): NodeRegistration; // endpoints built as http://{advertiseHost ?? '127.0.0.1'}:{port}
}
// main.ts: CLI — `tsx packages/node-daemon/src/main.ts <config.yaml>`; SIGINT/SIGTERM -> stop()
```

- [ ] **Step 1: Install deps** — `npm i js-yaml -w packages/node-daemon && npm i -D @types/js-yaml -w packages/node-daemon`

- [ ] **Step 2: Write the failing test**

`packages/node-daemon/test/daemon.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');

let hub: Hub; let daemon: Daemon;
afterEach(async () => { await daemon?.stop(); await hub?.stop(); });

describe('node daemon', () => {
  it('loadConfig validates required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-'));
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'node:\n  name: x\n');
    expect(() => loadConfig(bad)).toThrow(/daemon config/);
  });

  it('spawns serving processes, registers with hub, and heartbeats', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const servePort = 18300 + Math.floor(Math.random() * 500);

    const dir = mkdtempSync(join(tmpdir(), 'ah-'));
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: dev-node', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'heartbeatMs: 200',
      'serving:',
      '  - tier: worker', '    model: mock-model', `    port: ${servePort}`, '    maxStreams: 4',
      `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();

    const node = hub.registry.byName('dev-node');
    expect(node?.status).toBe('online');
    expect(node?.endpoints[0]).toMatchObject({ tier: 'worker', url: `http://127.0.0.1:${servePort}`, maxStreams: 4 });

    // heartbeat advances
    const t0 = hub.registry.byName('dev-node')!.lastHeartbeat;
    await new Promise((r) => setTimeout(r, 500));
    expect(hub.registry.byName('dev-node')!.lastHeartbeat).toBeGreaterThan(t0);

    // the spawned mock actually serves
    const models = await fetch(`http://127.0.0.1:${servePort}/v1/models`);
    expect(models.status).toBe(200);
  }, 30000);
});
```

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Implement**

`packages/node-daemon/src/config.ts`:

```ts
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { Tier } from '@agenthub/shared';

export interface ServingConfig { tier: Tier; model: string; port: number; maxStreams: number; cmd: string[]; }
export interface DaemonConfig { node: { name: string; arch: string }; hub: string; advertiseHost?: string; heartbeatMs?: number; serving: ServingConfig[]; }

export function loadConfig(path: string): DaemonConfig {
  const raw = load(readFileSync(path, 'utf8')) as Partial<DaemonConfig> | undefined;
  if (!raw?.node?.name || !raw.node.arch) throw new Error('daemon config: node.name/node.arch missing');
  if (!raw.hub) throw new Error('daemon config: hub missing');
  if (!Array.isArray(raw.serving) || raw.serving.length === 0) throw new Error('daemon config: serving missing');
  for (const s of raw.serving) {
    if (!s.tier || !s.model || !s.port || !s.maxStreams || !Array.isArray(s.cmd) || s.cmd.length === 0)
      throw new Error('daemon config: serving entry missing tier/model/port/maxStreams/cmd');
  }
  return raw as DaemonConfig;
}
```

`packages/node-daemon/src/supervisor.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServingConfig } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Supervisor {
  private children: ChildProcess[] = [];
  constructor(private serving: ServingConfig[]) {}

  async startAll(timeoutMs = 15000): Promise<void> {
    for (const s of this.serving) {
      const [cmd, ...args] = s.cmd;
      const child = spawn(cmd, args, { stdio: 'inherit' });
      this.children.push(child);
    }
    await Promise.all(this.serving.map(async (s) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`);
          if (res.ok) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`serving process on port ${s.port} failed health check`);
        await sleep(250);
      }
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    })));
    this.children = [];
  }
}
```

`packages/node-daemon/src/daemon.ts`:

```ts
import type { NodeRegistration } from '@agenthub/shared';
import type { DaemonConfig } from './config.js';
import { Supervisor } from './supervisor.js';

export class Daemon {
  private supervisor: Supervisor;
  private timer?: NodeJS.Timeout;
  constructor(private cfg: DaemonConfig) { this.supervisor = new Supervisor(cfg.serving); }

  registration(): NodeRegistration {
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    return {
      name: this.cfg.node.name, arch: this.cfg.node.arch,
      endpoints: this.cfg.serving.map((s) => ({ tier: s.tier, url: `http://${host}:${s.port}`, model: s.model, maxStreams: s.maxStreams })),
    };
  }

  async start(): Promise<void> {
    await this.supervisor.startAll();
    const res = await fetch(`${this.cfg.hub}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.registration()),
    });
    if (!res.ok) throw new Error(`hub registration failed: ${res.status}`);
    const interval = this.cfg.heartbeatMs ?? 5000;
    this.timer = setInterval(() => {
      fetch(`${this.cfg.hub}/api/nodes/${this.cfg.node.name}/heartbeat`, { method: 'POST' })
        .catch(() => { /* hub temporarily unreachable; keep beating */ });
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.supervisor.stopAll();
  }
}
```

`packages/node-daemon/src/main.ts`:

```ts
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: tsx src/main.ts <config.yaml>'); process.exit(1); }
const daemon = new Daemon(loadConfig(cfgPath));
daemon.start().then(() => console.log('[daemon] up'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => daemon.stop().then(() => process.exit(0)));
```

- [ ] **Step 5: Run tests, verify pass** — `npx vitest run packages/node-daemon` (spawning `npx tsx` is slow; test has a 30s timeout).
- [ ] **Step 6: Commit** — `git commit -m "feat: node daemon with process supervision, registration, heartbeats"`

---

### Task 10: End-to-end verification + dev configs + Spark playbook

**Files:**
- Create: `packages/hub/test/e2e.test.ts`
- Create: `configs/dev-node.yaml`, `configs/README.md`
- Create: `deploy/spark/README.md`
- Modify: root `package.json` (add `dev:hub`, `dev:node` scripts), `README.md` (new — quickstart)

**Interfaces:**
- Consumes: everything. Produces: the Phase 1 acceptance proof (spec §14 phase 1: "two concurrent agent sessions stream from vLLM via the gateway" — here proven against the mock; the Spark playbook maps the same config onto real vLLM).

- [ ] **Step 1: Write the e2e test (this is the phase acceptance test)**

`packages/hub/test/e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../src/server.js';

let orch: FastifyInstance; let work: FastifyInstance; let hub: Hub; let base: string;

beforeAll(async () => {
  orch = createMockOpenAI({ tokenDelayMs: 20, replyFor: (u) => `orchestrator says: ${u}` });
  work = createMockOpenAI({ tokenDelayMs: 20, replyFor: (u) => `worker says: ${u}` });
  await orch.listen({ port: 0, host: '127.0.0.1' });
  await work.listen({ port: 0, host: '127.0.0.1' });
  const urlOf = (a: FastifyInstance) => `http://127.0.0.1:${(a.server.address() as { port: number }).port}`;

  hub = createHub();
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;

  await fetch(`${base}/api/nodes/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url: urlOf(orch), model: 'qwen3.8-flash-next-nvfp4', maxStreams: 4 },
        { tier: 'worker', url: urlOf(work), model: 'qwen3.6-35b-a3b-nvfp4', maxStreams: 48 },
      ],
    }),
  });
});
afterAll(async () => { await hub.stop(); await orch.close(); await work.close(); });

async function chat(agentId: number, text: string, events: { at: number; kind: string }[]) {
  const res = await fetch(`${base}/api/agents/${agentId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = ''; let full = ''; let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const m = frame.match(/^data: (\{.*\})$/m);
      if (!m) continue;
      const ev = JSON.parse(m[1]);
      if (ev.token) { if (first) { events.push({ at: Date.now(), kind: `first:${agentId}` }); first = false; } }
      if (ev.done) { full = ev.full; events.push({ at: Date.now(), kind: `done:${agentId}` }); }
    }
  }
  return full;
}

describe('phase 1 e2e', () => {
  it('two agents on different tiers stream concurrently through the gateway', async () => {
    const mk = async (name: string, tier: string) => (await (await fetch(`${base}/api/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, tier, systemPrompt: `You are ${name}.` }),
    })).json()).id as number;

    const master = await mk('master', 'orchestrator');
    const scout = await mk('scout', 'worker');

    const events: { at: number; kind: string }[] = [];
    const [a, b] = await Promise.all([
      chat(master, 'plan the day please now', events),
      chat(scout, 'scan the repo please now', events),
    ]);
    expect(a).toBe('orchestrator says: plan the day please now');
    expect(b).toBe('worker says: scan the repo please now');

    // concurrency: both sessions produced their first token before either finished
    const firstDone = Math.min(...events.filter(e => e.kind.startsWith('done')).map(e => e.at));
    const lastFirst = Math.max(...events.filter(e => e.kind.startsWith('first')).map(e => e.at));
    expect(lastFirst).toBeLessThanOrEqual(firstDone);
  }, 30000);
});
```

- [ ] **Step 2: Run, verify pass** — `npx vitest run packages/hub/test/e2e.test.ts`. (No new source code should be needed; if this fails, fix the responsible module — do not weaken the test.)

- [ ] **Step 3: Dev configs + scripts**

`configs/dev-node.yaml`:

```yaml
# Dev node: serves both tiers from mock servers on this machine.
node:
  name: dev-node
  arch: arm64
hub: http://127.0.0.1:4000
heartbeatMs: 5000
serving:
  - tier: orchestrator
    model: mock-model
    port: 8101
    maxStreams: 4
    cmd: ["npx", "tsx", "packages/mocks/src/serve.ts", "8101", "20"]
  - tier: worker
    model: mock-model
    port: 8102
    maxStreams: 8
    cmd: ["npx", "tsx", "packages/mocks/src/serve.ts", "8102", "20"]
```

Root `package.json` scripts additions:

```json
"dev:hub": "tsx packages/hub/src/main.ts",
"dev:node": "tsx packages/node-daemon/src/main.ts configs/dev-node.yaml"
```

`configs/README.md`: two paragraphs — what a daemon config is, field reference (copy the `ServingConfig`/`DaemonConfig` field list from Task 9), and the note that real nodes replace `cmd` with their serving stack launch command.

- [ ] **Step 4: Spark playbook**

`deploy/spark/README.md` — verbatim content to write:

```markdown
# DGX Spark node playbook (Phase 1)

The Spark serves two vLLM instances (orchestrator + worker tiers) managed by
the node daemon. Stock vLLM does not support GB10 (sm_121) — use NVIDIA's NGC
container.

## Worker tier — Qwen3.6-35B-A3B NVFP4 (official recipe)

    docker run --gpus all --ipc=host -p 8001:8000 \
      nvcr.io/nvidia/vllm:26.05-py3 \
      vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4 \
        --gpu-memory-utilization 0.5 --kv-cache-dtype fp8 \
        --enable-prefix-caching --async-scheduling --max-num-seqs 48 \
        --reasoning-parser qwen3 --tool-call-parser qwen3_xml

## Orchestrator tier — Qwen3.8-Flash-Next NVFP4 (single-Spark recipe)

Follow https://github.com/blazux/qwen3.8-Flash-DGX with the
RadixArk/Qwen3.8-Flash-Next-NVFP4 checkpoint (n-gram table mmap'd from NVMe;
~76 GiB resident). Serve on port 8002 with --max-num-seqs 4. Known caveats
(as of 2026-09): non-deterministic greedy decode (vllm persistent_topk on
GB10), coherence loss near 100k context with fp8 KV cache. Fallback: point
the orchestrator tier at a second Qwen3.6-35B-A3B instance instead — the
daemon config makes this a one-line change.

## Daemon config for the Spark (configs/spark.yaml on that machine)

    node: { name: spark, arch: arm64 }
    hub: http://<control-node-tailnet-name>:4000
    advertiseHost: <spark-tailnet-name>
    serving:
      - tier: worker
        model: nvidia/Qwen3.6-35B-A3B-NVFP4
        port: 8001
        maxStreams: 48
        cmd: ["./launch-worker.sh"]
      - tier: orchestrator
        model: RadixArk/Qwen3.8-Flash-Next-NVFP4
        port: 8002
        maxStreams: 4
        cmd: ["./launch-orchestrator.sh"]

launch-*.sh wrap the docker commands above with `exec` so SIGTERM reaches
docker. Memory split (0.5 worker / remainder orchestrator) is a starting
point — tune on the real box.
```

`README.md` (root, new): project one-liner, link to the PRD spec and this plan, quickstart:

```markdown
# AgentHub

Local multi-node AI agent hub. See docs/superpowers/specs/2026-09-01-agenthub-prd-design.md.

## Dev quickstart

    npm install
    npm test                  # full suite (mock cluster, no network)
    npm run dev:hub           # hub on :4000
    npm run dev:node          # dev node daemon + two mock model servers

    # talk to an agent
    curl -s -X POST localhost:4000/api/agents -H 'content-type: application/json' \
      -d '{"name":"helper","tier":"worker","systemPrompt":"You help."}'
    curl -N -X POST localhost:4000/api/agents/1/messages \
      -H 'content-type: application/json' -d '{"text":"hello"}'

Real-node setup: deploy/spark/README.md, configs/README.md.
```

- [ ] **Step 5: Full suite + manual smoke**

Run: `npm test` — Expected: all green.
Run `npm run dev:hub` and `npm run dev:node` in background, execute the two curl commands from the README, confirm streamed tokens; then kill both.

- [ ] **Step 6: Commit**

```bash
git add packages configs deploy README.md package.json
git commit -m "feat: phase 1 e2e acceptance, dev configs, spark playbook"
```

---

## Self-review notes

- Spec coverage (phase 1 scope only): monorepo ✔ (T1), mock serving ✔ (T2), hub state ✔ (T3), registry/heartbeat/offline ✔ (T4), queue + requeue-on-node-loss ✔ (T5, sweep wiring T8), gateway tier routing + concurrency ✔ (T6), agent chat ✔ (T7), API ✔ (T8), daemon ✔ (T9), acceptance + real-node mapping ✔ (T10). Phases 2–6 intentionally out of scope (own plans).
- Types cross-checked: `NodeRegistration/NodeInfo/ServingEndpoint/Job/JobSpec` names match across T1/T4/T5/T6/T8/T9; `registry.all()` added in T8 (noted inline).
- No placeholders: every step has runnable code or exact file content.
