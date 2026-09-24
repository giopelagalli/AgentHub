# 0034 — Connect GitHub sits in the import tab, with a status line on Cluster
Date: 2026-09-24
Decided by: senior-coder

## Context
"Connect GitHub" needs a home in the UI. The rail has five pages (Projects, Computer, Cluster,
Allocation, Help) and there is no Settings. A non-technical member meets GitHub for the first time
at exactly one moment: they are making a project and want to import a repository.

## Options
- A — a GitHub page in the rail: a whole page, permanently in everyone's way, for something most
  members press once. Why not: it is a setting, not a place to work.
- B — the Help page's *Starting a project* section: where people look for instructions, not where
  they are when they need the button, and Help is prose.
- C (chosen) — the New-project dialog's **Import a repo** tab, with a one-line status on the
  **Cluster** page for managing an existing connection.

## Decision
The dialog is where the need arises, so that is where the button is. The Repository field has four
shapes, chosen by `repoFieldMode(status)`:

| hub | field |
|---|---|
| App registered, connected | a picker of the member's repositories, "or type owner/repo" beside it |
| App registered, not connected | **Connect GitHub** and one line: what picking repositories means |
| token only | today's typed field |
| neither | today's typed field, and a line saying public repositories still clone |

The free-text input is present in all four. A picker that is the *only* way in would strand anyone
whose repository the listing misses, and `repoProblem` already judges a typed name — so the picker
fills that input rather than replacing it, and what gets posted is the same field either way.
Choosing from it also sets the branch *placeholder* to the repository's default branch, which is
what leaving Branch blank already means.

Cluster gets one line — `GitHub: connected as acme · Manage on GitHub · Disconnect` — because that
page is for what the hub itself is wired to (nodes, cloud spend), and Disconnect needs a home that
is not a creation dialog. It is a line, not a panel.

## Consequences
Nothing new in the rail, and the button is in front of the member at the moment it means something.
The cost is that a member who wants to connect *before* making a project has to open New project to
find it, or press Connect on the Cluster page. If more hub-level settings arrive, this line is the
seed of the Settings page that would then be worth having — and this decision gets superseded
rather than stretched.
