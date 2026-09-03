# AgentHub Phase 4 — Telegram, Personal Assistant & Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Control the hub from Telegram (`/brief /projects /goals /todo /backlog /new /nodes` + free-form chat), backed by a personal assistant agent that keeps a human-readable markdown memory (MEMORY.md index + one-fact-per-file notes) and planner files (goals/todo/backlog), and that proactively sends a daily briefing, check-ins, and alerts.

**Architecture:** A transport-agnostic `TelegramPort` interface (real grammY long-polling adapter + an in-memory fake for tests) feeds a pure `CommandRouter`. The router calls the `Assistant` (an `AgentLoop` session on the orchestrator tier with memory/planner/project tools) and the Phase-3 `MasterOrchestrator`/`ProjectService`. A `Scheduler` fires the daily briefing, check-ins, and alerts (node offline, project blocked) through the same port. Outward-facing actions go through a confirmation gate (inline keyboard) before executing. Everything is testable with the fake port and a fake clock.

**Tech Stack:** unchanged + `grammy` (Telegram bot framework, long polling — no inbound port). Voice notes are an optional `VoiceAdapter` (default no-op; Kokoro hookup documented, not built).

**Spec reference:** PRD §7 (assistant + memory), §8 (Telegram), §13 (owner confirmation for outward actions), §14 phase 4 acceptance: */new creates a project from phone; briefing arrives on schedule with real project state.*

## Global Constraints

- Conventions from Phases 1–3 hold.
- Memory root `<memoryRoot>` (env `MEMORY_ROOT`, default `data/memory`): `MEMORY.md` (index: one line per note `- [Title](notes/<slug>.md) — hook`), `notes/<slug>.md` with YAML frontmatter `{ name, description, type: person|preference|routine|goal|fact|reference, created, updated }` and `[[wikilinks]]`, `planner/goals.md`, `planner/todo.md`, `planner/backlog.md` (markdown checklists: `- [ ] item` / `- [x] item`). Git-versioned with `simple-git`; every mutation commits `assistant: <summary>`.
- Telegram: only messages whose `chat.id` equals `TELEGRAM_OWNER_CHAT_ID` are processed; everything else is ignored silently. Bot token from `TELEGRAM_BOT_TOKEN`. The bot is not started when either env var is missing (hub logs one line and continues).
- Commands exactly: `/brief`, `/projects`, `/goals`, `/todo`, `/backlog`, `/new <title>: <intent>`, `/nodes`, `/help`. `/video` and `/controlnode` are Phase 6 (reply "coming in Phase 6"). Sub-forms: `/todo add <text>`, `/todo done <n>`, same for `/goals` and `/backlog`.
- Free-form text → the assistant. Assistant replies ≤ 3500 chars per Telegram message (split on paragraph boundaries beyond that).
- Confirmation gate: any tool flagged `outward: true` (none built in this phase; Phase 6 adds X posting) must return a pending action id and the bot must send an inline keyboard `[Confirm] [Cancel]`; execution only after Confirm from the owner chat. Build the gate now with a test tool so Phase 6 plugs in.
- Scheduler times are local-time `HH:MM` strings (`BRIEFING_TIME` default `08:00`; `CHECKIN_TIMES` comma list default `13:00,18:00`); a `Clock` interface (`now()`, `setTimeout`) is injected so tests never sleep.
- Never call any external API other than Telegram in this phase.

---

### Task 1: Memory store + planner

**Files:** `packages/hub/src/assistant/memory.ts`, `packages/hub/src/assistant/planner.ts`; tests `packages/hub/test/memory.test.ts`, `packages/hub/test/planner.test.ts`

**Interfaces — Produces:**

```ts
export interface NoteMeta { name: string; description: string; type: 'person'|'preference'|'routine'|'goal'|'fact'|'reference'; created: number; updated: number }
export class MemoryStore {
  static open(root: string): Promise<MemoryStore>            // creates MEMORY.md/notes/planner if missing, git init
  index(): Promise<{ name: string; description: string; file: string }[]>   // parsed from MEMORY.md
  read(name: string): Promise<{ meta: NoteMeta; body: string } | null>
  remember(input: { name: string; description: string; type; body: string }): Promise<NoteMeta>   // create or update note + index line; commit
  forget(name: string): Promise<boolean>
  recall(query: string, limit = 5): Promise<{ name: string; description: string; snippet: string }[]>   // case-insensitive substring over description+body, ranked by hit count
  indexText(): Promise<string>                                 // raw MEMORY.md for prompts
}
export type PlannerList = 'goals' | 'todo' | 'backlog';
export class Planner {
  constructor(root: string /* <memoryRoot>/planner */, commit: (msg: string) => Promise<void>)
  list(which: PlannerList): Promise<{ n: number; text: string; done: boolean }[]>
  add(which, text): Promise<number>          // returns 1-based n
  complete(which, n): Promise<boolean>
  remove(which, n): Promise<boolean>
  snapshot(): Promise<string>                // markdown of all three lists (open items only, ≤ 2000 chars)
}
```

**Tests:** open scaffolds files + initial commit; remember→index line present + file frontmatter round-trips; remember same name updates `updated` and replaces the index line (no duplicates); recall ranks a note with 2 hits above 1; planner add/complete/remove renumber correctly and `[x]` persists; snapshot excludes done items. Commit `feat(hub): assistant memory store and planner files`.

---

### Task 2: Assistant agent + confirmation gate

**Files:** `packages/hub/src/assistant/assistant.ts`, `packages/hub/src/assistant/tools.ts`, `packages/hub/src/assistant/confirm.ts`; tests `packages/hub/test/assistant.test.ts`, `packages/hub/test/confirm.test.ts`

**Interfaces — Produces:**

```ts
export interface PendingAction { id: string; description: string; run(): Promise<string>; createdAt: number }
export class ConfirmationGate { propose(description, run): PendingAction; confirm(id): Promise<string /* result */>; cancel(id): boolean; pending(): PendingAction[]; /* expire after 30 min via injected now */ }
export function assistantTools(deps: { memory: MemoryStore; planner: Planner; service: ProjectService; master: MasterOrchestrator; gate: ConfirmationGate; registry: NodeRegistry }): Tool[]
  // remember(name, description, type, body), recall(query), list_memory_index(),
  // planner_add(list, text), planner_complete(list, n), planner_list(list),
  // list_projects(), create_project(slug, title, intent), pause_project(slug), resume_project(slug), run_project_turn(slug, instruction?),
  // get_daily_briefing(), list_nodes(),
  // demo_outward_action(text) — outward:true; goes through the gate; returns "pending confirmation <id>"
export class Assistant {
  constructor(deps: { loop: AgentLoop; tools: Tool[]; memory: MemoryStore; planner: Planner })
  reply(text: string, opts?: { onToken? }): Promise<{ text: string; pending: PendingAction[] }>
  // system prompt (prompts in assistant.ts): who you are, owner-first, ALWAYS consult the memory index (inlined) + planner snapshot (inlined); use remember() when learning something durable about the owner; concise Telegram-friendly replies.
  // keeps a rolling conversation (last 20 turns) in the transcript under kind:'assistant', subject:'owner'
}
```

**Tests (scripted mock):** reply with script calling `planner_add` then content → planner file updated + text returned; `remember` tool creates a note; `demo_outward_action` → reply carries one pending action, gate.confirm runs it, cancel removes; expiry via injected now; system prompt contains MEMORY.md index text and the planner snapshot (assert via mock `lastRequest()`). Commit `feat(hub): personal assistant agent with memory tools and confirmation gate`.

---

### Task 3: Telegram port + command router

**Files:** `packages/hub/src/telegram/port.ts` (interface + `FakeTelegramPort`), `packages/hub/src/telegram/grammy-port.ts` (real adapter), `packages/hub/src/telegram/router.ts`, `packages/hub/src/telegram/format.ts`; tests `packages/hub/test/router.test.ts`, `packages/hub/test/format.test.ts`

**Interfaces — Produces:**

```ts
export interface InlineButton { text: string; data: string }
export interface OutgoingMessage { text: string; buttons?: InlineButton[][]; parseMode?: 'MarkdownV2' | 'HTML' | undefined; voice?: Buffer }
export interface IncomingMessage { chatId: string; text: string; messageId: number }
export interface IncomingCallback { chatId: string; data: string; callbackId: string }
export interface TelegramPort {
  send(chatId: string, msg: OutgoingMessage): Promise<void>
  onMessage(handler: (m: IncomingMessage) => Promise<void>): void
  onCallback(handler: (c: IncomingCallback) => Promise<void>): void
  answerCallback(callbackId: string, text?: string): Promise<void>
  start(): Promise<void>; stop(): Promise<void>
}
export class FakeTelegramPort implements TelegramPort { sent: { chatId; msg }[]; simulateMessage(chatId, text); simulateCallback(chatId, data) }
export class GrammyPort implements TelegramPort { constructor(token: string) }   // long polling; maps callback_query; splits >3500-char texts
export class CommandRouter {
  constructor(deps: { port: TelegramPort; ownerChatId: string; assistant: Assistant; service: ProjectService; master: MasterOrchestrator; planner: Planner; registry: NodeRegistry; gate: ConfirmationGate })
  start(): void   // registers handlers; ignores non-owner chats
  handle(text: string): Promise<OutgoingMessage[]>   // pure-ish: used by tests and by the port handler
}
export function formatProjects(briefings: Briefing[]): OutgoingMessage   // one line per project + inline buttons pause/resume per slug (data `proj:pause:<slug>`), `proj:turn:<slug>`
export function formatBriefing(text: string, briefings: Briefing[]): OutgoingMessage
export function formatNodes(nodes: NodeInfo[], streams: Record<string, number>): OutgoingMessage
export function formatPlanner(which, items): OutgoingMessage
export function splitMessage(text: string, max = 3500): string[]
```

Router rules: `/help` lists commands; `/brief` → `master.dailyBriefing()`; `/projects` → formatProjects; callbacks `proj:pause|resume|turn:<slug>` act then edit/reply; `/goals|/todo|/backlog [add <text> | done <n>]`; `/new <title>: <intent>` → `service.create({ slug: kebab(title), title, intent })` → reply with the slug + immediately schedule a first turn (non-blocking) → reply again when the first briefing lands; `/nodes` → formatNodes; `confirm:<id>` / `cancel:<id>` callbacks → gate; anything else → `assistant.reply` and if `pending.length` attach Confirm/Cancel buttons.

**Tests:** fake port: non-owner chat ignored; each command produces the expected message shape (use the scripted mock hub from Phase 3 tests for master/service); `/new` creates a bundle and replies twice (second after the first turn completes — await it in the test); callback pause flips status; free text with an outward action attaches buttons and confirm runs it. Commit `feat(hub): telegram port, grammY adapter and command router`.

---

### Task 4: Scheduler + proactive messages

**Files:** `packages/hub/src/telegram/scheduler.ts`, `packages/hub/src/telegram/alerts.ts`; tests `packages/hub/test/scheduler.test.ts`

**Interfaces — Produces:**

```ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): { clear(): void } }
export class Scheduler {
  constructor(deps: { clock: Clock; port: TelegramPort; ownerChatId: string; master: MasterOrchestrator; service: ProjectService; assistant: Assistant; briefingTime: string; checkinTimes: string[]; tz?: string })
  start(): void; stop(): void
  // computes next fire times in local time; on briefing: master.dailyBriefing() → formatBriefing → send; on check-in: assistant.reply('(scheduled check-in) Ask the owner one useful question about today based on the planner and memory.') → send
  nextFire(kind: 'briefing'|'checkin', from: number): number   // pure, tested
}
export class Alerts {
  constructor(deps: { port; ownerChatId; registry; service; clock })
  attach(events: { onNodeOffline(cb: (n: NodeInfo) => void): void; onBriefing(cb: (b: Briefing) => void): void }): void
  // node offline → "⚠️ node <name> went offline; N jobs re-queued"; briefing status 'blocked' → "⛔ <title> is blocked: <blockers>"; dedupe: same alert key not re-sent within 30 min
}
```

Hub wiring hooks: `sweepAndRequeue` emits node-offline events (add a tiny `HubEvents` emitter in server.ts: `nodeOffline`, `briefingPublished` fired by ProjectService when a briefing lands).

**Tests:** fake clock; `nextFire` for times before/after now and across midnight; scheduler fires briefing exactly once per day boundary; check-in message goes to owner; alerts dedupe within 30 min; blocked briefing triggers alert. Commit `feat(hub): scheduled briefings, check-ins and alerts over telegram`.

---

### Task 5: Hub wiring, config, assistant API + UI reception hookup

**Files:** `packages/hub/src/main.ts`, `packages/hub/src/server.ts` (routes `POST /api/assistant/messages` SSE identical framing to agent chat; `GET /api/planner`, `POST /api/planner/:list {text}`, `POST /api/planner/:list/:n/done`; `GET /api/memory/index`), `.env.example` (TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, BRIEFING_TIME, CHECKIN_TIMES, MEMORY_ROOT, PROJECTS_ROOT), `packages/ui/src/main.ts` + `packages/ui/src/panels/chat.ts` (chat panel accepts a custom endpoint; the 1F reception hotspot now opens the assistant chat instead of the placeholder dialog — keep the dialog line "ASSISTANT" + [Talk][Close]); tests `packages/hub/test/assistant-api.test.ts`

**Steps:** wire `MemoryStore`, `Planner`, `ConfirmationGate`, `Assistant`, `CommandRouter` (only if env present), `Scheduler`, `Alerts` in `createHub` behind an `assistant` option (tests pass a `FakeTelegramPort`); routes tested via inject + SSE fetch; UI: reception → assistant chat works against the dev mock. Commit `feat: assistant API, telegram wiring and reception desk chat`.

---

### Task 6: Phase 4 acceptance test + docs

**Files:** `packages/hub/test/e2e-telegram.test.ts`, README "Telegram & assistant" section, `deploy/telegram.md` (BotFather steps, finding your chat id, Kokoro voice-note hookup as a future `VoiceAdapter`)

**Scenario (spec §14 phase 4):** hub with FakeTelegramPort + fake clock + scripted mock: owner sends `/new Website refresh: rebuild the landing page` → bundle created, two replies (ack + first briefing); non-owner sends `/brief` → nothing; advance the fake clock to BRIEFING_TIME → exactly one briefing message whose text contains "Website refresh"; owner sends free text "remember that I prefer morning meetings" (script: remember tool) → MEMORY.md index gains a line; `/todo add call the bank` then `/todo` lists it. Commit `test: phase 4 acceptance — telegram control and scheduled briefing`.

## Self-review notes

- PRD §7: memory store (T1), planner (T1), assistant (T2), proactive behaviors (T4), voice notes → explicit optional adapter, documented (T6). §8: commands (T3), owner allowlist (T3), confirmation before outward actions (T2 gate + T3 buttons). §14 phase-4 acceptance = T6.
- Deferred: `/video`, `/controlnode` (Phase 6), Kokoro TTS, Gemini/Grok/websearch tools (Phase 6 plug into `assistantTools` + the gate).
