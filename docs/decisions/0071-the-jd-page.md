# 0071 — The JD page: where it sits, how JD's HTML is drawn, how the mic works
Date: 2026-10-01
Decided by: designer
Status: accepted

## Context
FR-C4's UI half: chat with JD from a phone or a laptop, in the redesign's language (0048). Three
choices were not fixed by 0069 or the brief: where JD lives in the navigation-only sidebar, how
JD's Telegram-HTML is rendered without trusting it, and whether the mic is hold-to-talk or a
toggle.

## Options
Placement
- A — with Machines and Help at the bottom: those are system places; JD is the conversation the
  owner returns to most, and dimming it there hides it.
- B (chosen) — one row at the top, above search and the projects, labelled with JD's name from
  `/api/jd/status` ("JD" until known).

Sanitising
- A — DOMPurify: a dependency (the brief allows none) for a five-tag allow-list.
- B — a regex/tokeniser of our own: entities and malformed nesting are where those go wrong.
- C (chosen) — `DOMParser` into an inert document (no script runs, nothing loads), then a walk that
  *rebuilds* only `b i u s code pre a` as fresh elements; a link only for an absolute http(s) URL,
  with `rel="noopener noreferrer" target="_blank"`; any other element contributes its text,
  `script`/`style`/`iframe`/… contribute nothing. No string reaches `innerHTML`.

The mic
- A — hold to record: on iPhone Safari a long press fights text selection and the callout menu,
  there is no way to discard short of sliding, and it is unusable from a keyboard.
- B (chosen) — tap to start; the composer becomes a recording row (discard ×, a red dot, the time,
  send ↑). Escape discards. Five minutes stops and sends on its own. Recorded as WebM/Opus where
  offered, else MP4 (Safari), else Ogg, and uploaded with the bare container type.

## Decision
B, C, B. Also: the page is mounted eagerly like Help and Machines — it pulls in no library, so
there is nothing to lazy-load. Rendering is keyed by message id so a voice note keeps playing while
new messages arrive; an `edit: true` replaces its bubble. Enter sends (`enterkeyhint="send"`),
Shift+Enter is a new line; the field is 16px on a phone so Safari does not zoom. Voice notes play
through a plain `<audio preload="none">` started inside the tap, which is what Safari needs, against
the hub's byte ranges (0070).

## Consequences
- Telegram tags outside the subset (spoilers, blockquotes) show as plain text.
- Voice needs a secure context: over plain HTTP on the tailnet the mic says so instead of
  recording; the public HTTPS site is where it works on a phone.
- The stream reconnects with 1 s → 30 s backoff (and at once when a sleeping tab wakes), reloading
  history after a gap so nothing said meanwhile is missed.
