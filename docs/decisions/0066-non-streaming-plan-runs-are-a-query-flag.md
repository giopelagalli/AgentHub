# 0066 — Non-streaming PRD draft and roadmap: `?wait=1` on the existing routes
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
JD creates a project from an idea and needs a drafted PRD (and a roadmap) back. Creating a project
deliberately does not wait on a model, and the draft and roadmap routes answer SSE, which JD's tool
layer (one request, one JSON answer) cannot use well.

## Options
- A — `draft: true` on `POST /api/projects`, drafting before replying. Puts a model run on the
  create path the code explicitly keeps model-free, and needs its own story for "created, but the
  draft failed".
- B — new routes (`/prd/draft-sync`, …). Two more routes to allow-list and keep in step.
- C (chosen) — `?wait=1` on `POST /api/projects/:slug/prd/draft` and `…/roadmap/generate`.

## Decision
C. Same handler, same run, same busy broadcasts and abort-on-hang-up; the reply is the stream's
closing `done` frame as one JSON body (`{ done, full, questions, audit }` for the draft,
`{ done, full, milestones }` for the roadmap), or 502 `{ error }` if the run failed. JD calls
create, then `prd/draft?wait=1`, then `roadmap/generate?wait=1`.

## Consequences
The allow-list stays route-shaped (query flags are not part of it), so an assistant token may also
use the streaming form — harmless. A client that times out before the model finishes aborts the
run, exactly like a closed stream; JD must give these calls a generous timeout.
