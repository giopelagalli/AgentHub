# 0044 — An owner edit is a commit, in whichever repository the workspace is
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
The Code screen lets the owner change a file in `workspace/` (FR-B3). The next turn reads that
workspace, and — for an imported project — the next verified milestone pushes it to the owner's
GitHub repository. So "where does the edit go" is not a detail: an edit nothing records is an edit
the agents overwrite without ever knowing it happened.

## Options
- A — write the file and leave it. The bundle picks it up at the next agent commit, attributed to
  whatever the agent was doing; an imported workspace never picks it up at all, because the bundle
  ignores it.
- B — queue edits and commit them in a batch. More machinery, and the window where the file on disk
  and the history disagree is exactly the window a turn might start in.
- C (chosen) — commit on save, `Owner edit: <path>`, in whichever repository owns the workspace.

## Decision
`writeCodeFile` (`packages/hub/src/projects/code.ts`) writes the file and commits at once. When
`workspace/.git` exists the workspace is its own checkout — an imported repository — and the commit
goes there, staging only that path; otherwise the workspace is versioned by the bundle and
`ProjectBundle.commit` takes it. The message is `Owner edit: <path>` in both cases, so the log says
who changed what without a separate audit trail.

The commit runs with an explicit environment (PATH, HOME, the AgentHub Bot identity) rather than the
hub's own: `GIT_EDITOR`, `GIT_DIR` or a credential helper inherited from the process is somebody
else's configuration. `core.hooksPath=/dev/null` and `--no-verify` keep the repository's own hooks
out of it, for the reason 0028 gives — `workspace/.git/hooks` is a directory agents write.

Two kinds of file are written and deliberately *not* committed, reported to the UI as
`committed: 'none'` rather than as a failed save:

- One matching the credential convention `Github.pushWorkspace` already holds out of a milestone
  push (`isCommitExcluded`: `.env*`, `*.pem`, `*.key`). Committing a `.env.production` here would
  put it in the history that the next verified milestone pushes to the owner's repository — the
  exclusion at push time would not save it, because by then it is in a parent commit.
- One the repository's own ignore rules already exclude. `git check-ignore` is asked first, so a
  build artefact the owner opened and tweaked saves cleanly instead of failing after the write.

## Consequences
Every owner edit that belongs in history is one commit, and an imported project's edits ride the
same branch the milestone push uses, so the owner's pull request contains them. A noisy history is
the cost: saving five times makes five commits. Paths containing a `.git` or `node_modules` segment
are refused outright, on read as well as write — the tree does not show them, so a request naming
one did not come from the screen.

An edit that was not committed is one the next turn may overwrite without knowing, which is why the
UI says so in the save toast rather than reporting a plain "Saved".
