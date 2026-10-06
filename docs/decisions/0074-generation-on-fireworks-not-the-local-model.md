# 0074 — AgentHub generates on Fireworks for now; the Spark's local model is paused for it
Date: 2026-10-01
Decided by: owner
Status: accepted

## Context
Until now projects on **Auto** preferred the Spark's local vLLM model and fell back to Fireworks.
On 2026-10-01 the owner asked that everything AgentHub generates use the Fireworks API instead,
with the local model's use paused ("rn lets just use fireworks api if you generate anything not
the local"). JD keeps calling the local model directly; this is about the hub's own work.

## Options
- A — keep local-first routing: the owner's call was to stop using it for now.
- B — stop the Spark's node daemon: works at once (Auto falls back to cloud) but also takes the
  node's other jobs offline; the stopgap used on the day.
- C (chosen) — a per-node **Pause models** switch (0054) that takes the node's models out of
  routing while the node stays online; the owner turns it on for the Spark (until then, stopping the daemon does the same).

## Decision
Generation runs on Fireworks' cheap tier (glm-5p3-flash, deepseek-v4p1-flash; hard models stay off,
0002) by pausing the Spark's models. Local-only projects are refused rather than sent to the cloud
(0054), so privacy holds.

## Consequences
- Every turn costs money, bounded by `MAX_CLOUD_USD_PER_DAY`.
- Local-only projects cannot run while the pause is on.
- Lifting it is one switch on the Machines page, when the owner says local is back.
