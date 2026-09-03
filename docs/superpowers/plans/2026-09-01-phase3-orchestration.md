# AgentHub Phase 3 — Orchestration & Portable Project Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A master orchestrator supervises one long-lived orchestrator per active project; each project orchestrator owns a portable on-disk knowledge bundle, plans and delegates work to ephemeral subagents (tool-using LLM sessions), records decisions, and publishes structured briefings the master reads. A project can be paused, the hub restarted, and the project rehydrated from its bundle into a coherent briefing. Project floors appear in the tower UI.

**Architecture:** A generic tool-use `AgentLoop` (OpenAI-compatible tool calling through the gateway) with a small tool registry (workspace shell/file tools, job submission, subagent spawning, bundle updates). `ProjectBundle` is a filesystem+git module (manifest.yaml, project.md, decisions.log.md, tasks.yaml, briefings/, skills/, workspace/). `ProjectOrchestrator` runs *turns* (bounded loop invocations) on a scheduler or on demand; `MasterOrchestrator` reads only `briefings/latest.json` files and exposes project lifecycle commands. All agent conversations persist in SQLite and stream to the UI.

**Tech Stack:** unchanged + `simple-git` (for per-project bundle commits) — everything else is stdlib.

**Spec reference:** PRD §5 (orchestration model — adopted verbatim), §6 (project bundles), §14 phase 3 acceptance: *pause project → restart hub → rehydrate from bundle → coherent briefing.*

## Global Constraints

- Conventions from Phases 1–2 hold (ESM, strict TS, vitest, `npm test`/`typecheck` green per commit, conventional commits with the Co-Authored-By trailer).
- Tiers: master + project orchestrators run on `orchestrator`; subagents on `worker`. Never hardcode a model name — always via the gateway tier.
- The master never reads raw project context: its only inputs are `briefings/latest.json` (structured) + `latest.md` (short prose) per project, plus its own command log.
- Bundle paths: `<projectsRoot>/<slug>/` with exactly the files in PRD §6. `slug` = kebab-case `[a-z0-9-]{1,40}`. Every bundle mutation by an orchestrator ends in a git commit inside the bundle (`simple-git`), message `agent: <summary>`.
- Tool calls follow the OpenAI chat-completions `tools`/`tool_calls` schema. The mock server must support a scripted tool-call mode (Task 1) so every loop test runs offline.
- Subagent shell tools are sandboxed to `<bundle>/workspace` using Phase-2's `resolveWorkspace` rule (reuse the function by moving it into `@agenthub/shared` if needed).
- Turn budget: an orchestrator turn is at most 12 tool calls; a subagent session at most 25. Exceeding the budget ends the turn with a `budget-exhausted` note in the transcript — never an infinite loop.
- Briefing schema (JSON, exact): `{ slug, title, status: 'active'|'paused'|'blocked'|'done', priority: 'interactive'|'project'|'batch', summary: string (≤600 chars), progress: { done: number; total: number }, blockers: string[], nextSteps: string[], updatedAt: number }`.

---

### Task 1: Mock server tool-calling mode + gateway tool support

**Files:**
- Modify: `packages/mocks/src/openai-mock.ts` (+ test), `packages/hub/src/gateway.ts` (+ test), `packages/shared/src/index.ts`

**Interfaces — Produces:**

```ts
// shared
export interface ToolDef { type: 'tool'; name: string; description: string; parameters: Record<string, unknown> /* JSON schema */ }
export interface ToolCall { id: string; name: string; arguments: string /* JSON text */ }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ChatResult { content: string; toolCalls: ToolCall[]; finish: 'stop' | 'tool_calls' | 'length' }
// gateway
chat(tier, messages, opts?: { onToken?: (t: string) => void; tools?: ToolDef[]; signal?: AbortSignal }): Promise<ChatResult>
  // BACKWARD-COMPAT: keep the old positional signature working via overload or by having AgentRuntime.send adapt; existing tests must not change.
// mocks
createMockOpenAI({ ..., script?: ScriptStep[] })  // ScriptStep = { toolCalls: {name, arguments: object}[] } | { content: string }
  // when script is given, each POST consumes the next step in order (streaming tool_calls deltas per OpenAI format; final chunk finish_reason 'tool_calls'); when exhausted falls back to echo.
  // When a request carries messages with role 'tool', the echo reply is `echo: ${lastToolContent}` so tests can assert tool results reached the model.
```

The gateway assembles streamed `tool_calls` deltas (index/id/name/arguments fragments) into complete `ToolCall`s; `onToken` fires only for content deltas. `AgentRuntime.send` keeps its current behavior (no tools) via the new signature.

**Steps (TDD):** mock test — scripted step streams tool_calls chunks and `[DONE]`; gateway test — receives `toolCalls` with parsed name/arguments and `finish:'tool_calls'`; a plain reply gives `finish:'stop'`; existing gateway/agent/e2e tests stay green. Commit `feat: tool-calling support in gateway and mock`.

---

### Task 2: ProjectBundle (filesystem + git)

**Files:**
- Create: `packages/hub/src/projects/bundle.ts`, `packages/hub/src/projects/schema.ts`
- Test: `packages/hub/test/bundle.test.ts`

**Interfaces — Produces:**

```ts
export interface Manifest { schema: 1; slug: string; title: string; status: 'active'|'paused'|'blocked'|'done'; priority: Priority; intent: string; links: string[]; createdAt: number; updatedAt: number; index: string[] /* relative paths of bundle files */ }
export interface TaskItem { id: string; title: string; status: 'backlog'|'in-progress'|'done'|'blocked'; owner?: string; notes?: string }
export interface Tasks { tasks: TaskItem[] }
export class ProjectBundle {
  static create(root: string, init: { slug; title; intent; priority? }): Promise<ProjectBundle>   // scaffolds all files, git init + initial commit
  static open(root: string, slug: string): Promise<ProjectBundle>                                  // throws if manifest missing/invalid
  static list(root: string): Promise<Manifest[]>
  readonly dir: string; readonly workspace: string;
  manifest(): Promise<Manifest>; setStatus(s): Promise<void>; setPriority(p): Promise<void>;
  readProject(): Promise<string>; writeProject(md: string): Promise<void>;
  appendDecision(entry: { title: string; rationale: string; by: string }): Promise<void>;   // dated markdown entry
  tasks(): Promise<Tasks>; writeTasks(t: Tasks): Promise<void>;
  skills(): Promise<{ name: string; body: string }[]>; writeSkill(name, body): Promise<void>;
  publishBriefing(b: Briefing): Promise<void>;   // briefings/<ts>.json + .md, latest.json + latest.md overwritten
  latestBriefing(): Promise<Briefing | null>;
  commit(message: string): Promise<void>;        // simple-git add -A + commit (no-op if clean)
  contextPack(): Promise<string>;                // manifest + project.md + open tasks + last 5 decisions + skill names, ≤ 12k chars, for rehydration
}
```

**Steps (TDD):** create scaffolds exact file set + git log has 1 commit; decisions append with date header; tasks round-trip; publishBriefing writes timestamped + latest; `open` after `create` in a fresh process (new instance) rehydrates identical manifest; `contextPack` truncation at 12k. Commit `feat(hub): portable project bundles with git history`.

---

### Task 3: AgentLoop + tool registry

**Files:**
- Create: `packages/hub/src/agents/loop.ts`, `packages/hub/src/agents/tools.ts`, `packages/hub/src/agents/transcript.ts`
- Modify: `packages/hub/src/db.ts` (table `sessions(id PK, kind TEXT, subject TEXT, tier TEXT, started_at, ended_at, outcome TEXT)`, `messages` gains `session_id INTEGER NULL`, `tool_call_json TEXT NULL`)
- Test: `packages/hub/test/loop.test.ts`, `packages/hub/test/tools.test.ts`

**Interfaces — Produces:**

```ts
export interface Tool { def: ToolDef; run(args: unknown, ctx: ToolContext): Promise<string> }   // returns tool result text
export interface ToolContext { bundle?: ProjectBundle; hub: HubDeps; sessionId: number; log(line: string): void }
export function workspaceTools(): Tool[]   // read_file, write_file, list_dir, run_shell (argv; via runShellTask against bundle.workspace; 60s default timeout)
export function bundleTools(): Tool[]      // update_project_md, add_decision, update_tasks, write_skill, publish_briefing (validates schema)
export function hubTools(): Tool[]         // submit_job (POST-equivalent via queue), spawn_subagent (Task 4), list_nodes
export class AgentLoop {
  constructor(deps: { gateway: ModelGateway; transcript: Transcript })
  run(opts: { kind: 'master'|'orchestrator'|'subagent'; subject: string; tier: Tier; system: string; user: string; tools: Tool[]; ctx: Omit<ToolContext,'sessionId'|'log'>; maxToolCalls: number; signal?: AbortSignal; onToken? }): Promise<{ sessionId: number; text: string; toolCalls: number; outcome: 'stop'|'budget-exhausted'|'error'|'aborted' }>
}
```

Loop: system+user → gateway.chat(tools) → for each tool_call: run tool (errors become `error: ...` tool results, never throws out) → append assistant+tool messages → repeat until `finish==='stop'` or budget. Transcript persists every message with `session_id`; the SSE/UI story from Phase 5 is untouched (agents table stays for the staff floor).

**Steps (TDD):** with the scripted mock: a script `[toolCalls:[read_file]] → [content:'summary']` produces text `summary`, 1 tool call, the tool result appears in the request messages (mock echoes it — assert via the transcript); budget of 1 with a 2-step script → `budget-exhausted`; tool throwing → tool result string starts with `error:` and loop continues; `run_shell` escaping the workspace returns an error result. Commit `feat(hub): tool-using agent loop with persistent transcripts`.

---

### Task 4: ProjectOrchestrator + subagents

**Files:**
- Create: `packages/hub/src/projects/orchestrator.ts`, `packages/hub/src/projects/prompts.ts`
- Test: `packages/hub/test/orchestrator.test.ts`

**Interfaces — Produces:**

```ts
export class ProjectOrchestrator {
  constructor(deps: { bundle: ProjectBundle; loop: AgentLoop; gateway; queue; registry; transcript })
  turn(opts?: { instruction?: string; signal? }): Promise<Briefing>
    // 1) contextPack → system prompt (prompts.ts: role, bundle contract, briefing schema, "spawn subagents for concrete tasks; update tasks.yaml; record decisions; end by publishing a briefing")
    // 2) AgentLoop.run(kind:'orchestrator', tools: workspace+bundle+hub, maxToolCalls 12)
    // 3) if the loop ended without publish_briefing, synthesize one from tasks.yaml (progress counts) + last assistant text (summary ≤600) and publish it
    // 4) bundle.commit('agent: turn <n>')
}
// spawn_subagent tool (in hubTools, needs orchestrator deps): args { task: string; role?: 'coder'|'researcher'|'reviewer' } → runs AgentLoop kind:'subagent' on worker tier with workspace tools only, maxToolCalls 25, returns its final text (≤4k chars) as the tool result. Runs inline (awaited) in this phase; parallel fan-out is a later optimization.
```

**Steps (TDD):** scripted mock sequences: (a) orchestrator script publishes a briefing via tool → `turn()` returns it and `latest.json` exists; (b) script ends without publishing → synthesized briefing has progress from tasks.yaml; (c) script calls `spawn_subagent` → a `subagent` session row exists and its text appears as the tool result in the transcript; (d) pause/rehydrate: create bundle → run a turn that adds a task + decision → new `ProjectBundle.open` + new orchestrator instance (simulating restart) → `turn()` context pack contains the task and decision (assert on the system prompt captured by the mock request log — add `lastRequest()` to the mock in Task 1 if not present). Commit `feat(hub): project orchestrators with subagent delegation and briefings`.

---

### Task 5: MasterOrchestrator, scheduler, projects API

**Files:**
- Create: `packages/hub/src/projects/master.ts`, `packages/hub/src/projects/service.ts` (registry of open bundles/orchestrators, scheduler)
- Modify: `packages/hub/src/server.ts` (routes), `packages/hub/src/main.ts` (`PROJECTS_ROOT` env, default `data/projects`)
- Test: `packages/hub/test/projects-api.test.ts`, `packages/hub/test/master.test.ts`

**Interfaces — Produces:**

```ts
export class ProjectService {
  constructor(deps: { root: string; loop; gateway; queue; registry; transcript; tickIntervalMs?: number /* default 15 min */ })
  create(init): Promise<Manifest>; list(): Promise<Manifest[]>; get(slug): Promise<ProjectBundle>
  pause(slug); resume(slug); setPriority(slug, p); archive(slug)   // status changes + commit + queue: pause also requeues? NO — pause stops scheduling turns; running jobs finish
  runTurn(slug, instruction?): Promise<Briefing>                  // serialized per slug (no concurrent turns for one project)
  start(): void; stop(): Promise<void>                             // scheduler: every tick, run one turn for each 'active' project, highest priority first, sequentially
  briefings(): Promise<Briefing[]>                                 // latest per project
}
export class MasterOrchestrator {
  constructor(deps: { service: ProjectService; loop: AgentLoop })
  dailyBriefing(): Promise<{ text: string; briefings: Briefing[] }>   // AgentLoop kind:'master' with NO tools; input = all latest briefings JSON; output prose ≤1500 chars; falls back to a templated summary if the model returns empty
  command(text: string): Promise<{ text: string; actions: string[] }> // tools: create_project, pause_project, resume_project, set_priority, run_turn — master parses owner intent (Phase 4 Telegram will call this)
}
```

Routes: `GET /api/projects`, `POST /api/projects {slug,title,intent,priority?}`, `GET /api/projects/:slug` (manifest + latest briefing + tasks), `POST /api/projects/:slug/{pause|resume|archive}`, `POST /api/projects/:slug/priority {priority}`, `POST /api/projects/:slug/turn {instruction?}` (runs a turn, returns briefing), `GET /api/projects/:slug/transcript` (sessions + messages for the UI), `GET /api/briefings` (latest per project), `POST /api/master/brief`, `POST /api/master/command {text}`. `GET /api/state` gains `projects: Manifest[]`; WS `state` frames carry it; `broadcastState` after every project mutation.

**Steps (TDD):** API round-trips with the scripted mock; scheduler with `tickIntervalMs: 50` runs turns for active projects only (paused skipped) and serializes per slug; master daily briefing text contains each project title; `command('pause demo')` (script the mock to call pause_project) flips status. Commit `feat(hub): master orchestrator, project scheduler and projects API`.

---

### Task 6: UI — project floors

**Files:**
- Modify: `packages/ui/src/floors.ts` (floor list becomes `floorsFor(state)`: static `b1,f1,f2` + one `p:<slug>` floor per non-archived project (label `<N>F <TITLE>` uppercased, ≤14 chars + '…'), then `ph`; keep `FLOORS` export = the static list for tests), `packages/ui/src/render/floorplans.ts` (project floor plan generated from the 3F sample layout: orchestrator office, subagent stations = active subagent sessions count (cap 4), task board), `packages/ui/src/render/scene.ts`, `packages/ui/src/store.ts` (projects in hub state already), `packages/ui/src/panels/elevator.ts` (uses `floorsFor`), `packages/ui/src/main.ts` (hotspots: `project:board:<slug>` → tasks panel; `project:orch:<slug>` → dialog with latest briefing summary + [Run turn][Close]; `project:sign:<slug>` → status/priority)
- Create: `packages/ui/src/panels/tasks.ts` (task board panel from `GET /api/projects/:slug`)
- Remove: the static `f3` sample floor and `f4` vacant floor from `FLOORS` (vacant floor rendering stays as the plan for projects with zero tasks? NO — delete; a project floor with no tasks shows an empty board). PH remains; its briefing hotspot now shows the master's latest daily briefing (`POST /api/master/brief` on click, cached 10 min).
- Test: update `floors.test.ts` (floorsFor ordering/labels), `floorplans.test.ts` (generated project floor validates), `store.test.ts` if shape changes

**Art rule:** no new sprites are needed (reuse office/desk/board/agent); if the implementer believes new art is required, STOP and report — art goes to Opus/Fable.

**Steps (TDD):** pure tests first; then live check via the browser tools (hub + one project created via API → its floor appears in the elevator menu, its floor renders with the board; run turn from the dialog with the scripted mock hub… note the hub's real gateway needs a model: use the dev mock daemon). Commit `feat(ui): dynamic project floors with task boards and briefing dialogs`.

---

### Task 7: Phase 3 acceptance test + docs

**Files:** `packages/hub/test/e2e-orchestration.test.ts`, README section "Projects & orchestration", `docs/superpowers/specs` unchanged.

**Scenario (spec §14 phase 3):** hub A (temp projectsRoot, scripted mock: turn 1 adds two tasks + a decision + publishes briefing) → `POST /api/projects` → `POST .../turn` → `POST .../pause` → `hub.stop()` → hub B on the same projectsRoot/DB → `GET /api/projects/:slug` shows paused + latest briefing intact → `resume` → `turn` (mock script 2: publishes a briefing whose summary mentions the earlier task title, which the mock can only know if it was in the prompt — assert via mock `lastRequest()` that the system prompt contained the task title and the decision title) → coherent briefing returned. Commit `test: phase 3 acceptance — pause, restart, rehydrate`.

## Self-review notes

- PRD §5 bullets map: master (Task 5), project orchestrators (Task 4), subagents (Task 4 via spawn_subagent), persisted conversations visible in UI (Task 3 transcript + Task 6 transcript route consumption is deferred to the tasks panel's next iteration — the transcript API exists; UI shows briefing/tasks in this phase).
- §6 bundle layout and rehydration contract → Task 2 + Task 7.
- Deliberately deferred: parallel subagent fan-out, browser-lease tool (Phase 5b), video tool (Phase 6), Telegram command surface (Phase 4 consumes `MasterOrchestrator.command`).
