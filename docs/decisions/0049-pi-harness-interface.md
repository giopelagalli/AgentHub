# 0049 — pi's programmatic interface, verified; a `Harness` interface with pi behind an opt-in
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
Decision 0013 (owner) makes pi (pi.dev, open source) the eventual default employee harness, with
Claude Code optional and the built-in loop kept for the manager and as fallback. The PRD called
pi's programmatic mode a risk to spike first (FR-G2, Risks): if pi cannot be driven headlessly, or
cannot be pointed at the hub's own models, the whole of G falls over. This record is the spike's
result and the shape built on top of it.

## The spike — verified facts
Installed `@mariozechner/pi-coding-agent@0.73.1` (bin `pi`; repo `badlogic/pi-mono`; the npm
package `pi` is an unrelated maths toy) and ran it against a local OpenAI-compatible server.
Everything below was observed, not read off a README:

- **Headless.** `pi -p --mode json "<task>"` processes one prompt and exits; exit code 0 on
  success. There is also `--mode rpc` (a JSON-RPC conversation over stdin/stdout) — more than a
  one-shot task needs, and the adapter uses `--mode json`.
- **Event stream.** `--mode json` writes JSON Lines to stdout, LF-delimited, starting with
  `{"type":"session",...}`. The events the adapter reads: `tool_execution_start`
  (`toolCallId`, `toolName`, `args`), `tool_execution_end` (`toolCallId`, `toolName`,
  `result.content[]`, `isError`), and `message_end` (`message.role`, `message.content[]` of
  `{type:'text'|'toolCall'}` blocks, `message.usage` as `{input, output, cacheRead, cacheWrite,
  totalTokens}`, `message.errorMessage`). pi's own docs are explicit that records split on `\n`
  only — never on U+2028/U+2029 — so the reader does exactly that.
- **Custom endpoint.** `~/.pi/agent/models.json` (relocatable with `PI_CODING_AGENT_DIR`) declares
  providers: `{providers: {<name>: {baseUrl, api: 'openai-completions', apiKey, compat, models:
  [{id, name, reasoning, input, contextWindow, maxTokens, cost}]}}}`. `apiKey` may be the *name*
  of an environment variable rather than the secret, so the key never lands on disk. Selected with
  `--model <provider>/<id>`. Verified end to end: pi sent `POST <baseUrl>/chat/completions` with
  `stream: true`, `stream_options: {include_usage: true}`, `max_completion_tokens`, its four tools,
  and streamed the reply back. `compat.supportsDeveloperRole:false` /
  `supportsReasoningEffort:false` are what a non-OpenAI OpenAI-compatible server needs.
- **Tool restriction.** `--tools <names>` is a real allowlist, verified on the wire: with
  `--tools read,grep,find,ls` the request carried exactly those four tool definitions and no
  `write`/`edit`/`bash`. So a read-only pi *is* possible.
- **Prompt and task.** `--append-system-prompt <text>` adds to pi's own coding prompt (there is
  also `--system-prompt` to replace it); the task is a positional argument. `--thinking off`,
  `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates` make a run
  reproducible and keep the host's own pi setup out of it.
- **Working directory.** pi works in its cwd; there is no `--cwd`, so the adapter spawns it with
  `cwd: <workspace>`.
- **Files written.** pi reports them itself: the `write` and `edit` tool calls carry `args.path`,
  and their `tool_execution_end` says whether they succeeded.
- **Two things only the real binary tells you**, both found by running the finished adapter against
  pi 0.73.1 rather than against the tests' fake: `pi --version` prints to **stderr**, not stdout,
  so detection has to accept either stream; and pi accepts a piped-in prompt, so a child spawned
  with an ordinary stdin pipe waits forever even under `-p` — it must be spawned with stdin
  ignored. Both are now covered in `detect.ts` and `pi.ts`.

### Verified gaps
- **No containment.** `resolveToCwd` (pi's own path helper) expands `~` and returns an absolute
  path unchanged, so `write`/`edit`/`read` reach anywhere the OS user can, and `bash` obviously
  does. pi has no setting that confines it to its cwd.
- **No tool-call limit.** Nothing caps how many calls one run makes.
- **No cost ledger hook.** pi prices tokens from its own `models.json` costs; nothing reports a
  call back to the caller except the `message_end` usage numbers.
- The repo's strict OpenAI mock (`packages/mocks`) accepted pi's request and streamed the reply,
  then crashed in its own `usageChunk`: it assumes `message.content` is a string, and pi sends the
  array form the OpenAI wire format also allows. A mock defect, not a pi one; left alone here
  because the tests drive a fake `pi` rather than the real one.

## Options
- A — do not adopt pi: the spike says it can be driven, so there is no reason to.
- B — adopt pi as the default for every employee now: its file tools are uncontained and (until
  0050 put it behind the hub's door) its cost was invisible to the ledger; making it the default
  would quietly widen both. Why not.
- C (chosen) — a `Harness` interface with `builtin` unchanged as the default, `pi` behind an
  explicit per-employee (or per-project) opt-in, and every reason the opt-in cannot be honoured
  falling back to `builtin` with a line in the job log.

## Decision
`packages/hub/src/agents/harness/`: `Harness.run(task, ctx)` returning a report, the files written
and an outcome, with events emitted through `ctx.onEvent`. `builtin` wraps the existing
`loop.run` path with no behaviour change; `pi` spawns the CLI in the workspace and maps its stream
onto `TurnEvent`s. `TeamMember.harness` and `ProjectManifest.harness` select it;
`GET /api/harnesses` reports what the host can run and the drawer only offers those.

On the gaps:
- **Containment** is stated in the prompt, not enforced — and a write landing outside the
  workspace is dropped from `filesWritten` and logged. This is the same class of exposure the
  built-in `run_shell` already documents ("cwd-scoping, not a sandbox"), so pi is not a new kind
  of risk, but it is a wider one: the built-in *file* tools do check their paths and pi's do not.
  That is why pi is opt-in rather than the default. Real containment needs a sandboxed user or a
  container, for both harnesses at once.
- **Tool budget** is enforced by the adapter: it counts `tool_execution_start` events and kills
  the process group at the first call past `SUBAGENT_TOOL_CALLS`, so every call within the budget
  runs as it does on the built-in loop, with `HARNESS_WALL_CLOCK_MS` (20 min) as the
  backstop for a run that stalls without calling anything.
- **Files written** come from pi's own `write`/`edit` reporting, not a workspace scan: exact, free,
  and the same fidelity class as the built-in path. A file created only by `bash` is not reported —
  the same gap the built-in loop has for a shell command that builds its path at runtime.
- **The reviewer stays on `builtin`** (FR-G4). pi's `--tools` allowlist is genuinely read-only, so
  the *restriction* half of that condition is met; the *containment* half is not, and a reviewer
  that could rewrite what it is judging is the one case where that matters most.

## Consequences
pi is real and drivable, so G is not blocked. The hub gains a harness seam that Claude Code
(FR-G3) slots into without further surgery. Until containment exists, pi stays opt-in and the
owner turns it on per employee — 0013's "default for employees" is a later flip of that switch,
not this branch. The adapter depends on pi's JSON event field names; a pi release that renames
them degrades to "no events, empty report", which the fake-pi tests would catch on upgrade.
