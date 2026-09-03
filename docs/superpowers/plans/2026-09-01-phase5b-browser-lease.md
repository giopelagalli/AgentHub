# AgentHub Phase 5b — Browser Simulator & Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Mac mini's headed Chromium (on the virtual-HDMI display) becomes a shared cluster resource: agents acquire a lease to drive it through a small tool set, the owner can always preempt, sessions are recorded, and the tower's browser room shows the live screen with the lease holder badge.

**Architecture:** The node daemon gains an optional `browser` capability: a local Fastify server (`browser-server.ts`) wrapping a `BrowserDriver` (Playwright-backed in production, `FakeDriver` in tests) with navigate/read/click/type/screenshot/screencast endpoints. The hub owns the `LeaseManager` (single holder, priority FIFO, TTL + renew, owner preempt) and a `BrowserProxy` that forwards actions only for the current holder and relays screencast frames to UI WebSocket clients. `browserTools()` plug into the Phase-3 `AgentLoop`. A new UI floor "5F SCREENING ROOM" replaces the browser-shack stub with a live TV.

**Tech Stack:** unchanged + `playwright` (daemon devDependency; Chromium installed only on the Mac mini via the playbook). Tests never launch a real browser.

**Spec reference:** PRD §10 (browser simulator), §9 view 3 (browser room), §5 (browser-operator subagent type).

## Global Constraints

- Conventions from Phases 1–4 hold.
- Lease priority order: `owner` > `orchestrator` > `subagent`; owner acquisition preempts any holder immediately (holder's next action gets `409 lease lost`). Default TTL 120s, renewed by every action; expired leases release automatically and the next queued requester is granted.
- Daemon browser server binds `127.0.0.1` unless `advertiseHost` is set (then tailnet-only); the hub is the only client. Hub↔daemon browser calls carry the Phase-6 daemon token once it exists — design the client with an optional `authHeader` now.
- Screencast: JPEG frames ≤ 2 fps, ≤ 640px wide, relayed as `{type:'browser-frame', nodeName, leaseId|null, jpegBase64, at}` only to UI sockets that sent `{type:'subscribe', topic:'browser'}`; unsubscribed sockets never receive frames.
- Recording: every action while a lease is held appends a screenshot to `<bundle or memory root>/media/browser/<leaseId>/<seq>.jpg` + `actions.jsonl`; cap 200 frames per lease.
- Agents only get browser tools while holding a lease; every tool result includes the page title + URL so the model stays oriented.

---

### Task 1: BrowserDriver interface, FakeDriver, daemon browser server

**Files:** `packages/node-daemon/src/browser/driver.ts` (interface + `FakeDriver`), `packages/node-daemon/src/browser/playwright-driver.ts`, `packages/node-daemon/src/browser/server.ts`, config (`browser?: { enabled: boolean; port?: number; display?: string; headless?: boolean }`), `daemon.ts` (start/stop server; registration gains `browser?: { url: string }`), shared types; tests `packages/node-daemon/test/browser-server.test.ts`

```ts
export interface PageState { url: string; title: string }
export interface BrowserDriver {
  navigate(url: string): Promise<PageState>
  read(): Promise<{ state: PageState; text: string /* visible text, ≤ 20k chars */; links: { text: string; href: string }[] /* first 100 */ }>
  click(selector: string): Promise<PageState>          // CSS selector or `text=...`
  type(selector: string, text: string, submit?: boolean): Promise<PageState>
  screenshot(): Promise<Buffer>                         // JPEG ≤ 640px wide
  close(): Promise<void>
}
// server routes (JSON; screenshot returns image/jpeg): POST /browser/navigate {url}, POST /browser/read, POST /browser/click {selector}, POST /browser/type {selector,text,submit?}, GET /browser/screenshot, GET /browser/state
// FakeDriver: in-memory "pages" map url→{title,text,links}; screenshot returns a 1×1 JPEG constant; records calls for assertions.
```

Tests: server over FakeDriver round-trips every route; registration includes `browser.url` when enabled; daemon without `browser` registers none. Commit `feat(node-daemon): browser driver abstraction and local browser server`.

---

### Task 2: LeaseManager + BrowserProxy + hub routes

**Files:** `packages/hub/src/browser/lease.ts`, `packages/hub/src/browser/proxy.ts`, `packages/hub/src/browser/recorder.ts`, server routes; tests `packages/hub/test/lease.test.ts`, `packages/hub/test/browser-proxy.test.ts`

```ts
export type Requester = { kind: 'owner' | 'orchestrator' | 'subagent'; id: string; project?: string }
export class LeaseManager {
  constructor(opts: { ttlMs?: number; now?: () => number })
  acquire(r: Requester): { leaseId: string; granted: true } | { queued: true; position: number }
  release(leaseId): boolean; renew(leaseId): boolean; holder(): { leaseId; requester; expiresAt } | null; queue(): Requester[]
  expire(now?): string[]   // called by the sweep; returns released ids; grants next
  onChange(cb): void
}
export class BrowserProxy {
  constructor(deps: { registry; leases: LeaseManager; recorder: Recorder; fetch?: typeof fetch })
  act(leaseId, action: { op: 'navigate'|'read'|'click'|'type'|'screenshot'; args }): Promise<unknown>   // 409 if not holder; picks the online node with browser capability; records
  screencast(intervalMs = 500): { start(): void; stop(): void; onFrame(cb) }
}
// routes: GET /api/browser (holder, queue, node), POST /api/browser/lease {kind,id,project}, DELETE /api/browser/lease/:id, POST /api/browser/act {leaseId, op, args}, POST /api/browser/preempt (owner; kind owner), GET /api/browser/recordings/:leaseId
// WS: {type:'subscribe', topic:'browser'} → frames; hub relays via ws.ts broadcastTo(topic, msg)
```

Tests: priority + FIFO + preempt + TTL expiry (injected now); proxy 409 for non-holder; act forwards to a fake daemon server (spin the Task-1 server with FakeDriver in-process) and records frames; screencast frames only to subscribed sockets. Commit `feat(hub): browser lease manager, proxy, recorder and routes`.

---

### Task 3: Agent browser tools

**Files:** `packages/hub/src/agents/browser-tools.ts`; test `packages/hub/test/browser-tools.test.ts`; wire into `hubTools()` for orchestrators and a new `browserOperatorTools()` for subagents with role `browser-operator` (Phase-3 `spawn_subagent` gains that role).

Tools: `acquire_browser()` (returns lease or queue position; orchestrators wait ≤ 60s polling), `release_browser()`, `browser_navigate(url)`, `browser_read()`, `browser_click(selector)`, `browser_type(selector, text, submit)`, `browser_screenshot()` (returns "saved <path>" — the image goes to the recording, not the model context in this phase). Every tool auto-renews; a lost lease returns `error: lease lost — owner took control` and the loop continues.

Tests with the scripted mock + FakeDriver: script acquires, navigates, reads, releases → recording has 2 frames and the read text reached the model (mock echo). Commit `feat(hub): browser tools for agents`.

---

### Task 4: UI — screening room floor

**Files:** `packages/ui/src/floors.ts` (`f5` "5F SCREENING ROOM" inserted before PH), `floorplans.ts` (room: big wall TV 128×72 area, sofa row, lease badge plaque hotspot `browser:tv`), `scene.ts` (draw the latest frame into the TV area via an offscreen Image decoded from the WS frame; "NO SIGNAL" static when none), `net.ts` (subscribe on entering the floor, unsubscribe on leaving), `panels/browser.ts` (holder/queue list, [Take control] → POST preempt, [Release]), `main.ts` hotspots.

**Art rule:** the TV frame, sofa and "NO SIGNAL" static are new sprites → this task MUST run on Opus or Fable (art). Everything else is wiring.

Tests: floors ordering; floorplan validation; net subscribe/unsubscribe pure handlers. Live check: fake-driver daemon + hub → TV shows frames from a fake page. Commit `feat(ui): screening room with live browser screencast and lease controls`.

---

### Task 5: Mac mini playbook + acceptance

**Files:** `deploy/macmini/README.md` (Playwright install, `PLAYWRIGHT_BROWSERS_PATH`, headed Chromium on the dummy-HDMI display, `browser: { enabled: true, headless: false }`, keeping the display awake), `packages/hub/test/e2e-browser.test.ts`

**Scenario (spec §10/§14 phase 5):** hub + fake-driver daemon; subagent script acquires and navigates; owner preempts via `POST /api/browser/preempt` → subagent's next action gets `lease lost`; owner releases → queued orchestrator gets the lease; recording folder has the frames; UI-subscribed WS client received ≥1 frame. Commit `test: phase 5b acceptance — shared browser with owner preempt`.
