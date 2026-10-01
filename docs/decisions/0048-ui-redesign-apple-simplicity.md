# 0048 — Redesign the UI around one primary action, five sections and a settings sheet
Date: 2026-10-01
Decided by: owner (direction); orchestrator (the shape, `docs/design/redesign-2026-10.md`)
Status: accepted

## Context
The owner judged the UI cluttered and dated: every control and section had equal weight, settings
and internal terms sat on the page, and seven same-sized cards plus a wrapping control row left no
obvious next action. The ask: simplify, an intuitive Apple-like feel, new and modern.

## Options
- A — restyle the existing layout (colors, spacing): keeps the structural clutter; why not.
- B — adopt a component framework/design system (React + a UI kit): a rewrite of a working
  vanilla-TS app for a visual goal; why not.
- C (chosen) — keep the vanilla-TS app and its features; restructure the information architecture
  (sidebar = navigation, a toolbar with one primary action, five tabs, settings in a sheet, a
  merged Machines page) and replace the visual language (system font, hairlines over boxes,
  light+dark, translucent chrome, status dots).

## Decision
C, per the brief. Feature parity is a requirement; jargon is renamed on the surface only (API and
data names unchanged).

## Consequences
Every page's DOM changes; pure model functions and their tests stay. Light mode becomes a real
theme. Docs written before the redesign (guide screenshots, wording) need a pass.
