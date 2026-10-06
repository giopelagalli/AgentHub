# docs/site — the visual docs site

`index.html` is one self-contained page (inline CSS and JS, no build step, no dependencies). It is a
**view over the records**, never a source of truth. The sources are `docs/ROADMAP.md`,
`docs/ARCHITECTURE.md`, `docs/decisions/*.md`, `docs/guide.md`, `docs/prd-agenthub-v2.md`,
`docs/plan-*.md` and `docs/design/`. A fact that appears only on the site is a missing record:
report it, do not invent it.

The orchestrator publishes the file as a claude.ai Artifact and republishes to the same URL after
each sync. The file therefore has no `<!doctype>`, `<html>`, `<head>` or `<body>` tags: the
Artifact host wraps it. Browsers render it fine as it is; to look at it locally, serve the folder
(`python3 -m http.server`) and open `index.html`.

## Layout of the file

Six pages, each an `<article class="page" id="…">`, shown one at a time by the hash router:

| Page | id | Mirrors |
|---|---|---|
| Overview | `overview` | PRD overview, where each machine sits |
| How it works | `how` | `ARCHITECTURE.md`, one `<h2 id="how-…">` per module group |
| Decisions | `decisions` | `docs/decisions/`, one `<details class="dec">` per file |
| Timeline | `timeline` | decision dates, owner overrides, reversals, what shipped |
| What didn't work | `lessons` | rejected options, review corrections, known gaps |
| Roadmap | `roadmap` | `ROADMAP.md`: In progress, Next, Done |

Every block you edit is fenced by comments: `<!-- ==== SECTION: name ==== -->` …
`<!-- ==== /SECTION ==== -->`. Edit inside the fences. The "On this page" list, the pager, the
decision counts, the area chips and their counts are all computed by the script; never type a count.

## Adding or updating a decision

1. Copy an existing `<details class="dec">` block inside the `decisions` section and keep number
   order. Each block starts with a `<!-- ======== DECISION NNNN ======== -->` comment.
2. Attributes:
   - `id="d-<file stem>"`, e.g. `d-0073-media-is-a-per-employee-ability`. Every link to a decision
     uses this id (`href="#d-…"`), so never change an existing one.
   - `data-num`, `data-date` (from the record's `Date:`).
   - `data-by`: `owner`, `orchestrator`, `senior-coder` or `designer` (first word of `Decided by:`).
     An owner decision also gets `class="dec is-owner"`, which paints its number blue.
   - `data-status`: `accepted`, `superseded` or `missing` (no `Status:` line in the record).
   - `data-area`: space-separated keys from `agents models cost harness infra workbench github ui
     media browser jd door security product tooling`. A new key also needs a label in `AREAS` at
     the top of the script.
3. Summary: `.dec-num`, `.dec-title` (the record's title), `.dec-why` (one or two plain sentences:
   the problem and the choice), then `.dec-meta` with the date and pills:
   - Decided by: `pill-owner` (owner), `pill-orch` (orchestrator), `pill-agent` (senior-coder,
     designer). The label is the first word; the full `Decided by:` line goes in `title`.
   - Status: `<span class="pill pill-accepted">Accepted</span>`; superseded is
     `<a class="pill pill-superseded" href="#d-<successor stem>" title="<the full Status line>">Superseded by NNNN</a>`
     (the title keeps a partial supersession such as 0058's "the rest stands"); a record
     with no status line gets `pill-missing`.
   - Flags, only when the record says so: `pill-override` "Owner override" (the owner overrode a
     recommendation), `pill-fix` "Corrected after review" or "Changed by review", `pill-note`
     "Amended" (an addendum or later section), `pill-owner-soft` "Owner's rule".
4. Body: one `<section class="dec-sec sec-context|sec-options|sec-decision|sec-consequences">` per
   `##` of the record, with an `<h4>`. Extra sections use `sec-extra`; a Correction, Addendum or
   added Implementation choices section uses `sec-amend`. Options are `<ul class="opts">` with
   `<li class="opt-chosen">` on the chosen one and `opt-other` on the rest. Decision numbers in the
   text are links: `<a class="dref" href="#d-…">0050</a>`. End with
   `<p class="dec-src">Record: <code>docs/decisions/<file></code></p>`.
5. When a decision is superseded, update **both** blocks: the old one's status pill, and a mention
   in the new one's text if the record has it.
6. Then: the side-foot "Records as of / last decision" line, a Timeline item if it is an owner call,
   a reversal or a review fix, a Lessons card if it records something that failed, and the
   `Records` chips under the matching How it works section.

The `record-gaps` section on the Decisions page lists inconsistencies found in the records
(duplicate numbers, missing status lines, owner choices with no record). Remove an item once its
record is fixed; add one when you find a new gap, and report it.

## Timeline

Newest day first. Each day is `<li class="tl-day">` with a `.tl-date` (`MM-DD`, weekday · year) and
a list of `<li class="tl-item" data-kind="…">`:

- `owner` (blue dot): an owner decision. Add `pill-owner`, and `pill-override` when it overrode a
  recommendation.
- `turn` (amber): a change of direction or reversal. Add a `.from-to` line: `<s>old</s> → <b>new</b>`.
- `issue` (red ring): something broke, or a review found a hole.
- `ship` (green): shipped or verified.

Add `big` to the class for the few entries that matter most (owner overrides, reversals). Every item
ends with `<div class="refs">` links to its decisions. An owner choice without a decision file gets
`<span class="pill pill-missing">Record missing</span>` until one exists.

## What didn't work

Five groups (money, agents on real hardware, security findings, tools, plans that changed), each a
`.lessons` grid of `<article class="lesson">`: an `<h3>`, a `<dl>` with `dt.bad` "What happened"
(or "Why not"), `dt.good` "What replaced it" (or "Instead"), optional `dt.open` "Still open", and a
`.refs` line. Mine them from rejected options, `## Correction` sections and "Verified gaps".

## Roadmap

Mirror `ROADMAP.md` exactly: In progress (`.lane`, items with `pill-wait` "Waiting on the owner"
when they are), Next in order (`.lane-next`, `.ord` numbers are the real order), Done (`.done-list`,
one line per entry with its decision chips). Update the lane counts (`.n`) by hand; they are the
only typed counts.

## How it works and the diagrams

One `<h2 id="how-…">` per module group, with a matching link in the `nav-how` section of the
sidebar. Diagrams are inline SVG with `class="dg"` and use only these classes, so they follow the
theme: boxes `b`, `b-acc` (the subject), `b-ok`, `b-warn`; zones `z` with a `zl` label in capitals;
text `t` (title, 13px), `s` / `s2` (subtitle, 11px); arrows `ln`, `ln-acc`, plus `ln-d` for dashed;
`wall` for a boundary; `lt` for line labels. Keep a subtitle under about 28 characters for a
130 px box. Wrap each in `<figure class="fig"><div class="fig-scroll">…</div><figcaption>…</figcaption></figure>`.

## Rules

- Colours only through the tokens at the top of the `<style>`; light values on `:root`, dark ones in
  both dark blocks. No literal colours in new rules.
- localStorage holds only the theme and the last page, inside try/catch.
- After an edit, check desktop and phone width (no horizontal scroll), light and dark, and that the
  browser console is clean. Keep the file under 2 MB (it is about 0.4 MB).
- Plain words: say what a thing does for the owner; keep code names in `<code>`.
