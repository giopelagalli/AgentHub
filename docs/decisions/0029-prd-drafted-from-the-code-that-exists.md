# 0029 — An imported project's PRD is drafted from the code, and its roadmap starts with what already works
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
The drafter writes a PRD from a paragraph, as if the product did not exist. Run unchanged on an
imported repository it describes a system to be built from scratch — and the roadmap then sequences
rebuilding what is already there. The owner's words ("add SSO") are a *change* to a product, not the
product.

## Options
- A — leave the drafter alone and let the manager work it out from the workspace digest each turn:
  the PRD, which every turn reads, would stay wrong. Why not.
- B — skip the PRD for imported projects and drive from the roadmap: auto-run and the manager both
  gate on a drafted PRD, and the score is what tells the owner the plan is real. Why not.
- C (chosen) — give both model calls an *existing codebase* block, and tell each one what it is for.

## Decision
`codebaseContext(workspace)` is one bounded block: the README (6k), whichever top-level manifests
exist — `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` (2k each) — and `workspaceDigest`.
What the authors say it is, what it is built from, what is actually there.

The draft prompt gains `IMPORT_RULES`: describe the system in the present tense, the code is the
source of truth where it and the owner's words disagree, put what the owner asked for on top of it,
and invent nothing the repository does not have. The roadmap prompt gains `IMPORT_ROADMAP_RULES`:
lead with one `"status": "done"` milestone per capability already delivered, in build order, so the
first milestone *without* a status is the first thing still to build. `normalizeMilestones` already
validates `status`, so nothing else changed.

Both blocks are appended only when `manifest.source` is set; a project started from an idea or a
pasted PRD sees exactly the prompt it saw before.

## Consequences
The roadmap the owner reads starts with a list of what they already have, which is also what makes
"the first planned milestone" mean the right thing to the manager. Two costs: the drafter's prompt
grows by up to ~14k characters for an imported project, and the leading done-milestones are the
model's reading of the code, not verified — they carry no `verification`, and nothing pushes on
their account because only `complete_milestone` pushes.
