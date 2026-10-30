# Models and costs

## Models

**Settings → Models** on each project:

- **Auto (local first)** — the default. Local nodes serve everything; if the tier's local nodes
  are all busy the request waits for a slot; if none is *available* (offline, erroring) the
  request goes to a configured cloud provider, and comes back to local as soon as it is up.
- **Local only** — never spend; if local is unavailable the turn fails and says so.
- **Any cloud** / **Fireworks (default models)** / **Fireworks: <model>** — cloud first, local
  as the fallback. Picking a concrete model sets it for both tiers; an **Employees use** select
  appears to change the employees' model separately.
- **(off)** entries — the expensive tier (`glm-5p3`, `kimi-k3`). Greyed out until
  `FIREWORKS_HARD_MODELS=1` is set in `hub.env` and the hub restarted; a project that had one
  saved falls back to the provider's default while the switch is off.

**Machines → Nodes** shows every node's tiers and live stream counts, so you can see where a turn
is actually running.

## Costs

Every model request the hub serves is priced and recorded — the manager's turns, each employee's
subagent run, the one-on-one chats, the PRD and roadmap drafts, and the owner's own assistant.

**What is counted.** Prompt tokens, the cached part of them, and completion tokens, per request,
with the node and model that served it. Cost is
`(prompt − cached) × input + cached × cachedInput + completion × output`, at the per-million prices
below. **Local serving is $0** — hardware you already paid for bills nothing per token, and its
tokens are still recorded so you can see where the work went. Anthropic requests record their
tokens with **no dollar figure**: the hub has no Anthropic price table, and it will not guess one.

**Prices** (Fireworks, Standard serverless, USD per million tokens, as of **2026-09-23**):

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| `glm-5p3-flash` | $0.15 | $0.03 | $0.50 |
| `deepseek-v4p1-flash` | $0.22 | $0.007 | $0.66 |
| `glm-5p3` | $1.40 | $0.26 | $4.40 |
| `kimi-k3` | $3.00 | $0.30 | $15.00 |

A price that moves is a code change in `packages/hub/src/providers/fireworks.ts`, not a setting. A
model the hub has no price for shows as **price unknown** rather than as free.

**Where it shows.**

- **Model picker** — each model's input and output price, or "price unknown".
- **Overview** — what this project has cost in the last 24 hours, under *In this project*; the
  settings sheet repeats it under the schedule.
- **Activity** — each turn row carries what that turn cost, when it cost anything.
- **Employee drawer** — the Now line says what that employee's own model calls cost in the turn.
- **Machines → Nodes** — `Cloud spend: $1.20 in the last 24 h`, with the cap beside it when one is set.

**The daily cap.** Set `MAX_CLOUD_USD_PER_DAY` (in `hub.env`; decimals allowed, unset means no
cap). Once the trailing 24 hours of cloud spend reaches it, **cloud endpoints go out of rotation**
and local serving carries on as normal; a project that can only run in the cloud fails its turn
with *cloud spend cap reached*. Nothing is reset by hand — the cap lifts itself as the 24-hour
window slides past the spend. The crossing is logged once and, with the Telegram bot configured,
sent to you once.

One gap worth knowing: a call that never finishes — a turn you stopped, a turn that hit its time
limit, a dropped connection — is billed by the provider but recorded by nobody, because the token
counts only arrive with the last chunk. The hub will not guess them, so the figures here can be a
little under what the provider charges.
