# 0042 — node-pty pinned to 1.2.0-beta.15, because 1.1.0's prebuilt helper is not executable
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
`node-pty@1.1.0` is the current stable release. Its published tarball ships
`prebuilds/<platform>/spawn-helper` with mode `644`, and node-pty spawns that helper to hand the
child its tty: every `spawn()` fails with `Error: posix_spawnp failed.` unless the module is built
from source. Verified here — `tar -tvf` the 1.1.0 tarball, and the failure on a fresh install.

## Options
- A — 1.1.0 and build from source (`npm_config_build_from_source`): needs Xcode CLT or
  build-essential on every machine that installs, and the flag is npm-wide, so `better-sqlite3`
  recompiles with it; why not.
- B — 1.1.0 plus a repository `postinstall` that chmods the file: a repo-wide install script that
  exists to patch one dependency's permissions, and it runs on every `npm ci` forever; why not.
- C (chosen) — pin `node-pty` to `1.2.0-beta.15` exactly, whose tarball ships the helper `755` and
  which also carries `linux-arm64` and `linux-x64` prebuilds — the Spark among them.

## Decision
C, pinned exactly (`--save-exact`) rather than by range: a beta line is not one to float on. Nobody
needs a compiler on macOS or on 64-bit Linux; anywhere else npm falls back to `node-gyp rebuild`,
which the guide's operating section now says needs build tools.

## Consequences
The hub depends on a prerelease. Revisit when 1.2.0 ships: the pin should become a caret range then,
and this record superseded. If the beta is ever unpublished, option A is the fallback and the guide
gains a build-tools requirement everywhere.
