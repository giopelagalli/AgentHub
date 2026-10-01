# 0060 — A project's renders land in the bundle's media/, with a sidecar, committed
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
FR-E1–E2: `image-gen` joins `video-gen`, and a finished render belongs to the project. The plan's
Global Constraints had clips at `workspace/media/video/<jobId>.mp4` — inside the code the team
ships, with nothing recording what made them. Video's existing payload (MiniMax-H3: `mode`,
`durationSec`, `aspect`, `resolution`) does not carry what Wan 2.2 / LTX-2 templates take.

## Options
- A — keep `workspace/media/video/`: mixes generated assets into the shipped code, no sidecar; why not.
- B — a second, new video payload for the media path: two shapes on one job type, and the daemon has to guess which it got; why not.
- C (chosen) — every media job attributed to a project bundle lands at `media/<kind>-<jobId>.<ext>`
  in the bundle root beside `media/<id>.json` (prompt, params, job id, node, duration), committed
  by the hub as it arrives; `VideoPayload` grows optional `negativePrompt/width/height/seed/fps`
  so one shape serves both templates, with `seconds` the media-facing name for `durationSec`.

## Decision
C. Landing happens on the artifact upload (the render exists, the job is about to complete), so
the sidecar's duration is claim-to-upload. The hub picks the seed when a media request names none,
so every sidecar can reproduce its picture. A sidecar by the same id belonging to another job (a
hub whose database was reset) gets a suffix instead of being overwritten. Jobs without a bundle
(`_telegram`) keep the memory-root path.

A designer's `generate_image` / `generate_video` that gives up waiting — the turn's signal, or ten
minutes with no machine having claimed the job — **leaves the job queued** rather than cancelling
it, and says where it will land (`media/<kind>-<jobId>.<ext>`). The render is still wanted, a
cancel would throw away GPU work already queued, and the file arrives with its sidecar and commit
whenever the PC renders it. A job already rendering is waited for, bounded only by the turn.

## Consequences
`POST /api/video` with a `project` now lands in `media/` too (one test updated). The commit runs
outside the per-project turn chain, like every owner edit; a landing during a turn's own commit can
in principle meet git's index lock. Templates get `{{width}}`, `{{height}}`, `{{seed}}`,
`{{negativePrompt}}`, `{{seconds}}`, `{{fps}}`, `{{frames}}`; the H3 placeholders still fill.
