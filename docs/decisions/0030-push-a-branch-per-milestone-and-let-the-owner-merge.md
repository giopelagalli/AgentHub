# 0030 — Agents push `agenthub/<slug>`; the owner opens and merges the pull request
Date: 2026-09-24
Decided by: owner
Status: accepted

## Context
An imported project's work has to get back to GitHub or the import is one-way. The question is what
the hub is allowed to write, and with which credential.

## Options
- A — agents commit and push to the repository's own branch: fastest loop, and one bad turn rewrites
  the owner's trunk. Rejected by the owner.
- B — a deploy key per repository: narrower than a personal access token, but it is another secret
  per project and it still cannot open a pull request (that needs the API). **Deferred** — the
  owner's recommendation-over-ride note: a GitHub App installation, not a deploy key, is the next
  step (0028).
- C (chosen) — one branch per project, `agenthub/<slug>`, pushed after each *verified* milestone. The
  owner opens the pull request from the UI and merges it themselves.

## Decision
`complete_milestone`, and only it, pushes: when the milestone comes back `done` and the project has
a `source`, `pushWorkspace` commits whatever the milestone left in the workspace and pushes
`HEAD:refs/heads/agenthub/<slug>`. The destination is the URL the hub computes from `source`, never
the symbolic `origin` — `origin`'s URL lives in `workspace/.git/config`, which agents write, so
pushing to it would let a rewritten remote choose where the owner's code and the token's header are
sent (0028). `assertPushable` refuses if `pushBranch` ever equals `source.branch`, so the
repository's own branch is unreachable from code rather than by convention; it is checked at import
too, so a repository whose default branch is already `agenthub/<slug>` is refused with a 400 instead
of failing at the first milestone. `POST /api/projects/:slug/pr` opens the pull request,
`head: agenthub/<slug>`, `base: source.branch`, and is idempotent — it looks for an open one first,
because the owner will press the button again after a later milestone.

The push is an ordinary one and stays one. An earlier draft fell back to `--force-with-lease` on a
non-fast-forward; the fallback never fired (it matched on the wrong line of git's output) and,
pushing by URL, there is no remote-tracking ref for the lease to compare against. It is removed
rather than repaired: `agenthub/<slug>` is the hub's own branch, so a diverged copy means somebody
rewrote it, and that is worth telling the owner about rather than flattening. The push then fails
the way any other failure does — recorded, never fatal — and the owner deletes the branch if they
want the next milestone to land.

A failed push never fails the milestone. The work is verified and recorded either way; a missing
token or an unreachable remote is the owner's to fix, so it lands in `decisions.log.md` and as a
`text` turn event rather than undoing a verification.

Two consequences of the workspace being a real checkout were settled here too. The bundle now
ignores the whole of `workspace/` when it holds a `.git` — the same treatment a nested checkout has
always had, because `git add -A` would otherwise record a dangling gitlink. And with the bundle no
longer tracking those files, `changedWorkspaceFiles` reads the *workspace's* index instead: what a
milestone changed is what is still uncommitted there, since the previous milestone's work was
committed when it was pushed. That is what keeps the milestone reviewer pointed at real files.

What a milestone commits is everything it changed *except* `.env*`, `*.pem` and `*.key` at any
depth. A workspace is where agents wire things up, and a `.env` written to get something running is
not what the owner asked to have published to their repository. What is staged is read from the
index (`git diff --cached --name-only`) rather than from simple-git's `status.staged`, which does
not report a rename — a milestone that only renamed files used to commit nothing at all.

## Consequences
Nothing an agent does can reach a branch a human has not reviewed, and the pull request is the
review surface the owner already knows. The milestone boundary is now also a commit boundary in the
owner's repository: one commit per verified milestone, which reads well in a pull request but means
a milestone's intermediate states are not history. A project whose default branch is literally
`agenthub/<slug>` cannot be written back at all — it is refused at import.

The file exclusions are a convention, not a classifier, and the residual exposure is real: a
credential in `config.json`, `secrets.yaml` or a shell script is pushed like any other file, and the
pull request is where the owner catches it. In the other direction they are blunt — a tracked
`.env.example` or a checked-in test fixture ending in `.key` is held back from the commit with no
warning, and the owner has to commit it themselves.
