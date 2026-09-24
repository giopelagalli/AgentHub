# 0045 — The guide explains and never changes anything
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
FR-B4 docks a persona beside the Code screen that answers "what does this do" and "why". The
document personas next door (`prd`, `roadmap`, `docs`) each hold write tools, because the owner
talks to them in order to change their document. The question was whether the guide is another of
those.

## Options
- A — give it the workspace's `write_file` too, so "that's wrong, fix it" is one message. It would
  then be an agent doing untracked, unreviewed work outside a turn and outside a milestone.
- B — give it the docs tools, so it can write up what it explained. Then two personas own `docs/`.
- C (chosen) — read-only: `read_file`, `list_dir`, `read_bundle`, and nothing else.

## Decision
The guide's belt is exactly those three. It is a separate branch in `ProjectChat.reply`, not a
`DocPersona`, precisely so it cannot be handed a `PERSONA_TOOLS` entry later without somebody
deciding to. Its prompt is mostly about where an answer may come from: cite the `decisions.log.md`
entry or the PRD requirement number, and when nothing records a reason, say that instead of
inventing one. Its context carries the workspace digest, the docs list and the tail of the decision
log; the PRD it reads with `read_bundle` when a question needs it.

## Consequences
"Explain it" and "change it" stay different acts by different agents: the guide answers, and the
change goes through a turn where it is tested and reviewed. The cost is a round trip when the owner
wanted the fix — they either edit it themselves in the same screen (0044) or run a turn.

The `` `path:line` `` citation format is part of the contract, not a nicety: the markdown renderer
turns those spans into links, which is how the code map (FR-B5) and the tour (FR-B6) will navigate.
The guide is also the one chat whose replies are rendered as markdown rather than plain text, so
those citations are clickable where it is asked for them — `ChatTarget.onCodeRef` is what turns it
on, and no other caller passes it.
