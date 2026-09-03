# AgentHub Phase 2 — Multi-Node Jobs & Elasticity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nodes execute queued jobs (starting with `shell-task`), advertise which job types they can run, and the cluster is elastic: a node dying mid-job causes the job to re-queue and complete on another capable node; a node joining late immediately starts taking work. Ships with per-node deployment playbooks for the Spark, the 7900XTX box, the MacBook, and the Mac mini control node.

**Architecture:** The hub gains a job API (enqueue / claim / progress log / complete / fail / get) on top of the Phase-1 `JobQueue`; the node daemon gains a `JobRunner` that polls `claim` for the job types in its config and executes them (`shell-task` via `child_process` inside a configured workspace root), streaming log lines and a final result back. Node loss already re-queues running jobs via the sweep; this phase adds an attempts cap so poison jobs end as `failed`. The gateway learns to retry a chat on another endpoint when the first connection fails outright.

**Tech Stack:** unchanged (Node 22, TypeScript strict, Fastify, better-sqlite3, vitest). No new runtime deps.

**Spec reference:** docs/superpowers/specs/2026-09-01-agenthub-prd-design.md §3 (hardware/model matrix), §4.1 (node daemon), §4.3 (queue), §14 phase 2 acceptance: *kill the macbook daemon mid-job → job re-queues and completes on spark.*

## Global Constraints

- Phase-1/UI conventions hold: ESM, `.js` relative imports, strict TS, vitest under `packages/*/test`, `npm test` and `npm run typecheck` green at every commit, conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Job types exactly: `llm-session | video-gen | shell-task | browser-lease` (existing union). Only `shell-task` executes in this phase; the others remain queueable.
- All new hub routes live under `/api/jobs`. Daemons authenticate nothing yet (Phase 6). Daemons never receive API keys.
- Timestamps epoch ms; injectable `now` on queue methods (existing rule).
- `shell-task` execution is sandboxed to `<workspaceRoot>/<project ?? '_default'>`: the daemon `mkdir -p`s it, runs the command with `cwd` there, and refuses payloads whose `cwd` escapes it. Command is `payload.cmd: string[]` (argv form, spawned without a shell).
- Attempts cap: a job re-queued 3 times (attempts ≥ 3 when re-queued) becomes `failed` with `error: 'max attempts exceeded'`.
- Tests spawn real daemon child processes only in the elasticity e2e; everything else unit-tests pure functions or uses in-process hub + `app.inject`. Ports always `0` / ephemeral.
- No new UI work in this phase beyond keeping the job board's existing columns truthful (status/type/project are already shown).

---

### Task 1: Shared job types + node job-type capabilities

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/hub/src/db.ts` (schema additions), `packages/hub/src/node-registry.ts`
- Test: `packages/hub/test/node-registry.test.ts` (extend), `packages/shared/test/types.test.ts` (extend)

**Interfaces — Produces:**

```ts
// shared
export interface ShellTaskPayload { cmd: string[]; cwd?: string; timeoutMs?: number; env?: Record<string, string>; }
export interface JobResult { exitCode?: number; stdoutTail?: string; stderrTail?: string; data?: unknown; }
export interface Job { /* existing */ attempts: number; result: JobResult | null; error: string | null; }
export interface NodeRegistration { name; arch; endpoints; jobTypes?: JobType[]; }   // default []
export interface NodeInfo extends NodeRegistration { jobTypes: JobType[]; /* always present */ }
export interface JobLogLine { jobId: number; seq: number; line: string; at: number; }
```

- `db.ts`: `jobs` gains `attempts INTEGER NOT NULL DEFAULT 0`, `result_json TEXT`, `error TEXT`; `nodes` gains `job_types_json TEXT NOT NULL DEFAULT '[]'`; new table `job_logs(id PK, job_id INTEGER NOT NULL, seq INTEGER NOT NULL, line TEXT NOT NULL, at INTEGER NOT NULL)`. Use `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check so existing `data/hub.db` files upgrade in place (write a tiny `ensureColumn(db, table, column, ddl)` helper).
- `NodeRegistry.register` persists `jobTypes`; `toInfo` returns it; `online()` unchanged.

**Steps:** extend tests (registration round-trips `jobTypes: ['shell-task']`; a node registered without jobTypes reads back `[]`; opening a DB created with the OLD schema (create the old `jobs` table by hand in the test, then call `openDb`) results in the new columns existing) → fail → implement → pass → commit `feat: job result/attempt fields and node job-type capabilities`.

---

### Task 2: Queue attempts/results + hub job API

**Files:**
- Modify: `packages/hub/src/queue.ts`, `packages/hub/src/server.ts`
- Create: `packages/hub/src/job-logs.ts`
- Test: `packages/hub/test/queue.test.ts` (extend), `packages/hub/test/jobs-api.test.ts`

**Interfaces — Produces:**

```ts
// queue.ts additions
claim(types: JobType[], nodeId: number, now?): Job | null      // increments attempts on claim
complete(id: number, result?: JobResult, now?): void
fail(id: number, opts: { requeue?: boolean; error?: string }, now?): void
  // requeue && attempts >= 3  -> status 'failed', error 'max attempts exceeded'
requeueForNode(nodeId, now?): number                           // applies the same cap per job
get(id: number): Job | null                                    // now public
// job-logs.ts
export class JobLogs { constructor(db); append(jobId, line, now?): JobLogLine; list(jobId, afterSeq = 0): JobLogLine[]; }
```

Routes (all JSON):
- `POST /api/jobs` body `JobSpec` → `Job` (201). Validates `type` ∈ union, `tier` ∈ tiers, `priority` ∈ priorities; 400 otherwise. Broadcasts state.
- `GET /api/jobs/:id` → `Job` + `{ logs: JobLogLine[] }` (404 if unknown).
- `POST /api/jobs/claim` body `{ node: string; types: JobType[] }` → `Job` or `204` when nothing to claim; 404 unknown node; **403 if the node's registered `jobTypes` doesn't include every requested type**.
- `POST /api/jobs/:id/log` body `{ line: string }` → `JobLogLine`.
- `POST /api/jobs/:id/complete` body `{ result?: JobResult }` → `Job`. Broadcasts state.
- `POST /api/jobs/:id/fail` body `{ error: string; requeue?: boolean }` → `Job`. Broadcasts state.
- `GET /api/state` unchanged shape (jobs now carry attempts/result/error).

**Steps (TDD):** queue tests — claim increments attempts; `fail({requeue:true})` on attempts 3 → `failed` with the exact error string; `requeueForNode` applies the cap; `complete(id, result)` stores result. API tests via `app.inject` — enqueue+get, claim returns 204 when empty, 403 on type mismatch, claim→log→complete round trip with logs returned by GET. Commit `feat(hub): job API with claim, logs, results and attempt cap`.

---

### Task 3: Daemon JobRunner (shell-task executor)

**Files:**
- Modify: `packages/node-daemon/src/config.ts` (`jobTypes?: JobType[]`, `workspaceRoot?: string` default `<cwd>/workspace`, `claimIntervalMs?: number` default 1000), `packages/node-daemon/src/daemon.ts` (registration includes `jobTypes`; start/stop the runner), `packages/node-daemon/src/main.ts` (no change expected)
- Create: `packages/node-daemon/src/job-runner.ts`, `packages/node-daemon/src/shell-task.ts`
- Test: `packages/node-daemon/test/shell-task.test.ts`, `packages/node-daemon/test/job-runner.test.ts`

**Interfaces — Produces:**

```ts
// shell-task.ts (pure-ish: only child_process + fs)
export function resolveWorkspace(root: string, project: string | undefined, cwd: string | undefined): string
  // throws Error('cwd escapes workspace') when path.resolve(root, project ?? '_default', cwd ?? '.') is outside root
export function runShellTask(payload: ShellTaskPayload, opts: { workspaceRoot: string; project?: string; onLine: (line: string) => void; signal?: AbortSignal }): Promise<JobResult>
  // spawn(cmd[0], cmd.slice(1), { cwd, env: {...process.env, ...payload.env} }), no shell; stdout/stderr lines -> onLine (prefixed 'out: ' / 'err: '); resolves { exitCode, stdoutTail, stderrTail } (tails = last 2000 chars); rejects on spawn error; kills on timeoutMs (default 10 min) with exitCode null + error 'timeout'
// job-runner.ts
export class JobRunner {
  constructor(opts: { hub: string; node: string; types: JobType[]; workspaceRoot: string; claimIntervalMs: number; execute?: (job: Job, log: (line: string) => void) => Promise<JobResult> })
  start(): void; stop(): Promise<void>   // stop aborts the in-flight job and waits for its fail/complete report
}
```

Runner loop: every `claimIntervalMs`, `POST /api/jobs/claim`; on a job, execute (default executor dispatches on `job.type`: `shell-task` → `runShellTask`; any other type → `fail({error:'unsupported job type', requeue:false})`), posting each log line, then `complete` or `fail({error, requeue:true})`. One job at a time in this phase. Network errors on claim are swallowed (hub may be restarting); errors reporting completion are retried 3× with 500ms gaps then logged.

**Steps (TDD):** `shell-task.test.ts` — echo command yields exitCode 0 + `out: hello` line; nonzero exit reported; `cwd: '../../etc'` throws escape error; timeout kills a `node -e setInterval` command. `job-runner.test.ts` — in-process `createHub` + registered node with `jobTypes:['shell-task']`; enqueue a job; runner with an injected `execute` stub resolves → hub shows `done` with result; stub rejects → job goes back to `queued` with attempts 1; `stop()` during an in-flight (never-resolving until aborted) execute reports fail+requeue. Wire the runner into `Daemon.start/stop`. Commit `feat(node-daemon): job runner with sandboxed shell-task execution`.

---

### Task 4: Gateway endpoint failover

**Files:**
- Modify: `packages/hub/src/gateway.ts`
- Test: `packages/hub/test/gateway.test.ts` (extend)

**Behavior:** when `fetch` to the picked endpoint rejects (connection refused/reset) or returns 5xx **before any token has been streamed**, mark that endpoint `unhealthy` for 10s (skipped by `pick`) and retry once on the next-best endpoint. If tokens were already streamed, propagate the error (no double replies). `pick()` skips unhealthy endpoints; `activeStreams` accounting stays correct across the retry (decrement before re-pick). Expose `markUnhealthy(key, until)` only via a small internal Map; add `health(): Record<string, number>` for the UI later (not consumed now).

**Steps (TDD):** two nodes, worker tier — first endpoint URL points at a closed port, second at the mock → chat succeeds, `pick` now returns the second even with lower active count on the first; after the 10s window (inject `now`) the first is eligible again. Commit `feat(hub): gateway failover to the next endpoint on connect failure`.

---

### Task 5: Elasticity e2e (the phase acceptance test)

**Files:**
- Create: `packages/hub/test/e2e-elasticity.test.ts`
- Create: `packages/mocks/src/daemon-config.ts` helper (writes a temp daemon YAML: name, hub url, one mock serving entry on an ephemeral port, `jobTypes: ['shell-task']`, `workspaceRoot` temp dir, `claimIntervalMs: 200`, `heartbeatMs: 200`)

**Scenario (spec §14 phase 2, with mocks standing in for macbook/spark):**
1. Start hub in-process (`createHub({ staleMs: 1500, sweepIntervalMs: 300 })`, listen on port 0).
2. Spawn daemon "macbook" as a child process (`npx tsx packages/node-daemon/src/main.ts <cfg>`); wait until `/api/state` shows it online.
3. Enqueue `shell-task` job `{ cmd: ['node','-e','setTimeout(()=>console.log("done"),4000)'] }`.
4. Wait until the job is `running` on macbook's node id.
5. `SIGKILL` the macbook daemon process (not SIGTERM — simulate a lid-close/crash).
6. Spawn daemon "spark" (second config). Assert within 15s: job reaches `done`, `nodeId` = spark's id, `attempts` = 2, logs contain `out: done`.
7. Also assert the macbook node is `offline` in state.

Timeouts: test budget 60s. Clean up child processes in `afterAll` (SIGKILL any survivor) and temp dirs.

**Steps:** write the test (it is the deliverable), run it, fix any responsible module (don't weaken the test), commit `test: phase 2 elasticity acceptance — job survives node death`.

---

### Task 6: Deployment playbooks + node configs

**Files:**
- Create: `deploy/amd/README.md`, `deploy/macbook/README.md`, `deploy/macmini/README.md`, `deploy/tailscale.md`; update `deploy/spark/README.md` (add `jobTypes: ['shell-task','video-gen']` + workspaceRoot + advertiseHost notes)
- Create: `configs/spark.yaml`, `configs/amd.yaml`, `configs/macbook.yaml` (real-node examples; `hub: http://macmini:4000`, tailnet names as placeholders `<name>.<tailnet>.ts.net`)
- Modify: `configs/README.md` (new fields: jobTypes, workspaceRoot, claimIntervalMs), root `README.md` (cluster section: how to bring a node up/down)

Content requirements (exact facts from the spec §3, keep each playbook under ~60 lines):
- **amd**: Linux, ROCm, llama.cpp server (HIP build) serving `unsloth/Qwen3.6-35B-A3B-GGUF` UD-Q4_K_XL on port 8001 as `worker` tier, `--n-cpu-moe 12` note for 64K context, `maxStreams: 4`; `jobTypes: ['shell-task']`; video **not** enabled (cite ComfyUI#15314). systemd unit sketch for the daemon.
- **macbook**: llama.cpp (Metal) serving a Qwen3.6-27B GGUF Q4_K_M on 8001 as `worker`, `maxStreams: 2`, `jobTypes: ['shell-task']`; launchd plist sketch; "close the lid = node leaves; jobs re-queue" paragraph.
- **macmini**: control node — runs the hub (launchd plist sketch, `HUB_DB=/Users/<you>/agenthub-data/hub.db`, `PORT=4000`), builds the UI, no LLM serving; note the future Strix Halo switch (§4.2) and that `data/` must be rsynced on switch.
- **tailscale.md**: install on each node, MagicDNS names, `hub:` values use tailnet names, `advertiseHost` = node's tailnet name, no port-forwards.

**Steps:** write files; `npm test` still green (docs only); commit `docs: phase 2 node playbooks and example configs`.

## Self-review notes

- Spec §14 phase-2 acceptance is Task 5 verbatim with mocks; §4.1 job execution + capabilities → Tasks 1–3; §4.3 arbitration partially (per-node one-job-at-a-time; priorities via existing claim ordering); gateway robustness for multi-node → Task 4; real hardware → Task 6 playbooks.
- Out of scope, deliberately: video-gen execution (Phase 6), browser-lease (Phase 5b), auth (Phase 6), UI changes.
