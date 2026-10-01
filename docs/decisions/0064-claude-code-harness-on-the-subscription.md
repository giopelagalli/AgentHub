# 0064 — claude-code: the `claude` CLI on the host's subscription, sandboxed with outbound HTTPS
Date: 2026-10-01
Decided by: senior-coder (the subscription-only rule is the owner's)
Status: accepted

## Context
FR-G3 is the third harness. The owner's rule: Claude is available to employees through the Claude
Code **subscription**, signed in once in a terminal on the hub host — never the API, never a key
held by the hub. pi (0049, 0050, 0055) set the shape: a CLI subprocess in the workspace, its event
stream mapped onto `TurnEvent`s, inside an OS sandbox. Unlike pi, `claude` calls Anthropic itself,
so it cannot be pointed at the hub's door, and its login lives in the hub user's home.

## What was verified (claude 2.1.251, macOS 26.5, Max subscription, real runs with haiku)
- **Headless:** `claude -p --output-format stream-json --verbose … -- "<task>"` prints JSON Lines.
  `system/init` (cwd, model, tools, permissionMode, `apiKeySource: "none"` on a subscription);
  `assistant` — one event **per content block**, repeating `message.id` and `message.usage`; blocks
  are `text`, `thinking` (empty text, signature only) and `tool_use {id, name, input}` (Write/Edit
  carry `input.file_path`, absolute); `user` with `tool_result {tool_use_id, content, is_error}`;
  `result {subtype, is_error, result, usage, modelUsage, total_cost_usd, num_turns}`. Also
  `rate_limit_event` and other `system` subtypes, ignored. Several models appear in one run
  (haiku for side tasks), so `modelUsage` has one entry per model.
- **A signed-out CLI** still emits a `result`: `is_error: true`, `result: "Not logged in · Please
  run /login"`, exit code 1 (seen inside a sandbox that hid the keychain).
- **Flags:** `--tools` is the whole offered set (`"Read,Grep,Glob"` — a Write the model tries then
  fails with "No such tool available"); `--allowedTools` pre-approves; `--permission-mode dontAsk`
  denies anything not pre-approved instead of prompting; `--append-system-prompt` adds ours;
  `--safe-mode` drops the host's CLAUDE.md, skills, plugins and hooks, `--strict-mcp-config` drops
  MCP servers (claude.ai connectors leaked into `tools` without it); `--no-session-persistence`
  writes no transcript under `~/.claude/projects`. `--tools`/`--allowedTools` are **variadic**, so
  the task goes last after `--` (verified with a task starting with `-`). `--max-turns` counts model
  turns, not tool calls, so the budget is enforced as pi's is. `--model` is not passed: the
  subscription's default is used.
- **Login check:** `claude auth status --json` answers locally in ~1 s, no model call:
  `{loggedIn, authMethod: "claude.ai", apiProvider, …, subscriptionType}`.
- **Auth storage:** on macOS the login is in the keychain (`Claude Code-credentials`, reached via
  securityd); `~/.claude/.credentials.json` is the Linux form. `~/.claude.json` and
  `~/.claude/projects` are not needed by a run (verified hidden).
- **Claude Code's own temp dir** is `/tmp/claude-<uid>/…` — shared with the owner's own sessions —
  unless `CLAUDE_CODE_TMPDIR` moves it; without that every Bash call failed `EPERM` in the sandbox.
- **Claude Code's own sandbox** (settings `sandbox.enabled`) is Seatbelt/bwrap too, and looked to be
  picked up from this host's settings even under `--safe-mode` (the model was offered the Bash
  tool's `dangerouslyDisableSandbox` parameter). It is overridden off per run with
  `--settings '{"sandbox":{"enabled":false}}'`, since a sandbox cannot be started inside ours; the
  end-to-end run below used that flag and `CLAUDE_CODE_TMPDIR` together, so which of the two each
  Bash failure needed was not separated.
- **Our Seatbelt, end to end:** the adapter's exact command ran the real CLI: Write, Bash
  (`echo x > viabash.txt`) and the report all worked; both files were reported written. The rules
  it needed beyond pi's profile: `(remote tcp "*:443")`, `/private/var/run/mDNSResponder` and
  `com.apple.dnssd.service` for DNS, and `com.apple.SecurityServer` + `com.apple.securityd.xpc` for
  the keychain. **Unverified:** the Linux (bwrap) path — no Linux host here.

## Options
- A — run `claude` unsandboxed, relying on `--tools`/`dontAsk`: Bash can still reach anything the
  hub user can; no.
- B — Claude Code's own sandbox (`sandbox.enabled`, per run via `--settings`): it governs Bash
  only, not the CLI's own file tools, and its policy is the CLI's to change; ours is already
  verified and shared with pi.
- C — a key for the API in the hub (`ANTHROPIC_API_KEY`, or `claude setup-token` into the env):
  against the owner's rule.
- D (chosen) — our sandbox (0055) with a second network mode, `https`: outbound TCP 443 anywhere
  plus DNS, no door; on macOS the keychain reachable; on Linux `--share-net` and
  `/run/systemd/resolve` bound back for DNS.

## Decision
`harness/claude-code.ts` runs `claude` as above, in the workspace, inside `sandboxedCommand` with
`{ https: true, keychain: true }`: writes only the workspace (read-only for the read-only policy)
and a per-run temp dir (`TMPDIR` and `CLAUDE_CODE_TMPDIR`); the usual secrets hidden, plus
`~/.claude/projects` (the owner's other transcripts) and `~/.claude.json` (MCP config); `~/.claude`
otherwise readable, never writable — a writable `~/.claude/settings.json` would let a run plant
hooks the owner's own sessions execute unsandboxed. The environment is `secretsStripped()` minus
every `ANTHROPIC_*`, `CLAUDE_CODE_*` and `CLAUDECODE`, HOME kept: the run uses the host's login and
nothing the hub's environment says.

- **Tools:** `workspace` → `Read,Edit,Write,Bash,Grep,Glob`; `read-only` → `Read,Grep,Glob`.
- **Files written:** the `file_path` of each successful Write/Edit, in order, **plus a filesystem
  scan** for files modified since the run started (skipping `.git`, `node_modules`) — this catches
  what Bash wrote. A scan rather than the before/after `git status` first proposed: git in a
  workspace the agent could write runs that workspace's config (`core.fsmonitor`, clean filters),
  and it would run outside the sandbox, in the hub.
- **Usage:** one ledger row per model from `result.modelUsage` (or, for a run killed before its
  `result`, summed from the per-message usage, one per message id), `provider:
  'anthropic-subscription'`, `node: 'claude-code'`, `usd: null`; prompt tokens = fresh + cache
  reads + cache writes, cached = cache reads. Recorded through `AgentLoop.recordUsage`, the same
  hook every gateway call reaches. `cloudUsdSince` sums `usd`, so these rows never count toward
  `MAX_CLOUD_USD_PER_DAY`; the CLI's `total_cost_usd` (a list-price equivalent) is ignored.
- **Availability** (`detect.ts`): `claude --version` works, `auth status` says `loggedIn` with
  `authMethod: "claude.ai"` (asked with the stripped env, so a hub key cannot pass for it; an API
  login is refused), and the `https` sandbox probes OK. Unreadable status output → available with
  reason "login not verified", and the first run fails with the CLI's own message.
- **Selection:** as pi's — the member's, else the project's; the milestone reviewer never runs on
  it; browser/external tools or no bundle fall back to `builtin`, saying why. No door is needed.
- The shared process handling (process group, abort, wall clock, budget stop, JSON Lines) moved from
  `pi.ts` into `harness/process.ts`, used by both adapters.

## Consequences
- **Weaker network posture than pi's.** A claude-code run can reach any host on 443 — so anything
  it can read it can send anywhere, and `npm install`/`git fetch` over HTTPS work. The hidden-paths
  list is what limits what it can read; the guide says to give it ordinary workspace work only.
- **The subscription login is readable by the run** (it must be: the CLI uses it). On macOS a Bash
  command can ask securityd for it like the CLI does (`security find-generic-password`); on Linux
  it is a file. A run could exfiltrate the owner's Claude login over 443. Accepted as the price of
  "use the subscription"; recorded here so it is a known trade, not a surprise. Keychain items of
  other apps may also prompt on the owner's screen if asked for.
- On Linux a token refresh during a run cannot be saved (`~/.claude` is read-only in the sandbox);
  if runs there start failing as signed out, run `claude` once on the host. Unverified.
- A claude-code run bypasses the gateway: no failover, no `maxStreams`, no "pause models", and a
  local-only project policy does not apply — choosing claude-code for an employee is choosing
  Anthropic's cloud for their tasks.
- The subscription's own limits (5-hour/7-day windows, visible as `rate_limit_event`) apply and are
  not surfaced in the hub yet.
