# 0055 — pi runs inside an OS sandbox: Seatbelt on macOS, bubblewrap on Linux
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
Decision 0049 verified that pi has no workspace containment: its file tools take absolute paths
and its `bash` reaches anything the hub's OS user can. That is what keeps pi opt-in, keeps the
milestone reviewer on `builtin`, and blocks pi from becoming the default (0013, ROADMAP Next 4).
pi itself has no setting for it, so the containment has to come from the OS, around the process.
The hub runs on two kinds of host: the DGX Spark (Ubuntu, arm64) and dev Macs.

## What was verified, and where
**macOS — verified on this Mac (macOS 26.5, arm64, node 22, pi 0.84.1).** `/usr/bin/sandbox-exec`
is deprecated in its man page but present and working, and it is what Codex CLI and Claude Code's
sandbox runtime use on macOS. A deny-default profile was run around `sh`, `node`, the real `pi
--version`, `git` and `npm`:
- `(deny default)` plus `process-exec`/`process-fork`, `signal`/`process-info*` within the
  sandbox, `file-read*` and `sysctl-read` is enough for node and pi to start. **No mach service is
  needed**, and none is granted except `com.apple.bsd.dirhelper`: without it `confstr()` cannot
  name the per-user temp dir and every `/usr/bin/git` (an xcrun shim) prints three warnings. Mach
  lookups are what an `allow default` profile would leave open, and they are an escape (launch
  services, Apple events start processes *outside* the sandbox) — so deny-default it is.
- Writes: a write outside the allowed subpaths fails with `EPERM` (`sh: /tmp/outside-…: Operation
  not permitted`); inside the workspace it succeeds. `/dev/stdout`, `/dev/stderr` and `/dev/fd/N`
  are *opened for writing* by `echo … > /dev/stderr` and must be allowed explicitly, or ordinary
  shell scripts break.
- Network, per port, **reliable**: with `(allow network-outbound (remote ip "localhost:4555"))`
  only, `fetch` to `127.0.0.1:4555` and `localhost:4555` succeeded, `127.0.0.1:4556` and
  `1.1.1.1` failed with `EPERM`, and `example.com` failed at DNS (`ENOTFOUND`: the resolver is a
  mach service). Unix-socket connects are network-outbound too, so they are denied as well.
- `setuid` binaries (`/bin/ps`) cannot be exec'd inside — irrelevant to a coding agent.
- Nesting works: this verification itself ran inside another Seatbelt sandbox.
- Hiding a directory from reads: `(deny file-read* (subpath D))` also denies `lstat` of `D`, so a
  workspace *inside* a hidden data root breaks `realpath` and node's `process.cwd()` (EPERM on
  lstat of the ancestor). Denying `file-read-data file-read-xattr` instead leaves metadata (names
  via `stat`, not via listing) and works. A more specific operation beats `file-read*` whatever
  the order, so the re-allow for the bundle and workspace must name the same two operations; with
  those, rules of the same operation follow "last match wins". Verified: a sibling project's file,
  the hub's DB and a fake `~/.ssh/id` read as EPERM, `ls` of the projects dir fails, while the
  workspace, its bundle and `git status` (whose `.git` is in the bundle) work.
- End to end, the finished `sandboxedCommand` around the real pi 0.84.1 against a canned door:
  pi made both model calls through the door, its `bash` wrote inside the workspace, a write
  outside failed with `Operation not permitted`, and a `fetch('https://example.com')` failed. pi
  also wrote `auth.json` and `models-store.json` into `PI_CODING_AGENT_DIR` — its config dir has to
  be writable, so it is the run's temp dir.

**Linux — from bubblewrap's documentation and the two reference implementations; not run.**
No Linux host or VM was available to this session; only the owner can run it on the Spark.
- `bwrap` is packaged (`bubblewrap`) and needs unprivileged user namespaces. **Ubuntu 24.04+
  restricts those through AppArmor** (`kernel.apparmor_restrict_unprivileged_userns=1`; Claude
  Code's sandbox runtime documents the same), so whether `bwrap` works on the Spark depends on its
  AppArmor policy. Hence detection *runs* the sandbox rather than looking for the binary.
- `--unshare-net` gives the process a new network namespace with only `lo`, which is not the
  host's loopback — the hub's door on `127.0.0.1:<port>` is unreachable from inside.
- `--die-with-parent` kills the whole sandbox when `bwrap` (or the hub) dies, and with
  `--unshare-pid` the command's tree dies with the namespace's init. `--new-session` puts the
  command in its own session, so the process-group kill in `pi.ts` reaches `bwrap` only — which
  is enough, through those two.
- A read-only bind still lets a process `connect()` to a unix socket on it (the read-only check
  does not apply to socket inodes), so `/run` (Docker's `docker.sock`, D-Bus, ssh-agent) has to be
  hidden with a tmpfs, not just bound read-only.

## Options
Linux, network:
- A — share the host network, confine only the filesystem: simplest, but pi could then send
  anything it can read (which is most of the disk) anywhere. Why not.
- B — Landlock (kernel ≥ 5.13; TCP-port rules need ABI 4, kernel ≥ 6.7) through a helper: no
  user namespaces, so no AppArmor question, but there is no packaged CLI — it means shipping and
  building a native helper. Why not, for now; it is the fallback if the Spark's AppArmor refuses
  `bwrap`.
- C (chosen) — `--unshare-net` plus a **door bridge**: the hub serves a per-run unix socket that
  pipes to its own `127.0.0.1:<port>`; inside the sandbox a few lines of node (the same node
  binary, run with `-e`) listen on the namespace's own `127.0.0.1:<port>` and pipe each connection
  to that socket, then start pi. pi's `models.json` is unchanged and the door is the only thing it
  can reach — the same guarantee Seatbelt gives on macOS, which is what Claude Code's runtime does
  too (with `socat`; node is already guaranteed here, `socat` is not).

macOS, profile shape:
- A — `(allow default)` minus writes and network: smallest profile, but leaves every mach service
  open, which is a known way out. Why not.
- B (chosen) — `(deny default)` with the allowances listed above.

## Decision
`harness/sandbox.ts`:
- `sandboxedCommand(platform, { workspace, tmpDir, door, writableWorkspace, hidden, readable,
  argv })` returns the wrapped `{ cmd, args }` (plus `doorSocket` on Linux, the path the hub must
  serve the bridge on), or `{ unavailable }` on any other platform or for a door off loopback.
  Pure, so its argv is what the tests pin; `hiddenPaths(hostSecrets(), workspace)` supplies
  `hidden` and `readable` from what exists on the host.
- **Writable:** the workspace — not for the read-only tool policy (the reviewer), where it is
  read-only too — and the run's own temp dir (pi's config dir, also `TMPDIR` and
  `npm_config_cache`). Nothing else, not `~/.npm`: a shared cache another process later trusts is
  a way to plant something outside the workspace.
- **Readable:** everything, so node, npm and toolchains work, **except** the hub's own data root
  (`DATA_ROOT`, else `./data` — the DB and every other project), `HUB_DB`/`PROJECTS_ROOT`/
  `MEMORY_ROOT` when set apart from it, the repo's `configs/`, the GitHub App key
  (`GITHUB_APP_PRIVATE_KEY`), and `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.docker`.
  The workspace and the temp dir are readable again inside them, and so is the workspace's bundle
  when the workspace has no `.git` of its own (a project the hub created versions it there).
  Rules go in path-depth order — an ancestor before what is inside it — so the same list means
  the same thing as Seatbelt rules ("last match wins") and as bwrap mounts (`--tmpfs` over a
  hidden directory, `--ro-bind /dev/null` over a hidden file, then the binds back).
- **Network:** the door only. The door must be on loopback: Seatbelt can only name
  `localhost:<port>`, and the Linux bridge listens on the namespace's loopback. A hub with a
  wildcard bind already hands pi `http://127.0.0.1:<port>` (`selfBase` in `server.ts`); a hub bound
  to one address (`HUB_HOST=100.x`, the documented control-node setup) is refused — detection and
  selection both say `the hub's door is on 100.x, not loopback (HUB_HOST=100.x)`, and the run falls
  back to `builtin`. A second loopback listener for that case is left for later.
- `sandboxStatus({ doorBase })` refuses an off-loopback door without probing, then probes by
  running a real sandboxed command (the darwin profile; on Linux the full `bwrap` line including
  the hidden paths and the node bridge). A success is cached for the process; a failure is probed
  again next time. If it fails, pi is **not offered**: `GET /api/harnesses` reports
  `available: false` with the reason, and a run that asks for pi falls back to `builtin` saying
  why — pi never runs unconfined.
- `pi.ts` runs pi through it; the out-of-workspace write warning stays as a second line of defence.
- The milestone reviewer may run on pi with `--tools read,grep,find,ls` behind
  `HARNESS_REVIEWER_PI=1`, **off by default**: the review task is written for the built-in
  `read_file`/`list_dir` belt, the verdict line has not been observed coming back from a real pi
  run, and the Linux sandbox has not run on the Spark.

## Consequences
- Inside the sandbox pi has no network but the door: `npm install` and fetching from a remote
  fail. A project's dependencies must already be installed in the workspace. Lifting that (a
  per-project opt-in) is a later decision; the interface has no switch for it yet.
- Reads are confined by a deny list, not an allow list: anything secret outside the listed paths
  (a token in a dotfile we did not name) is still readable and could be written into the
  workspace, which an imported project's push carries out. On macOS hidden paths still show their
  metadata (`stat` works; listing and reading do not).
- **Remaining gap on Linux: unix sockets.** `/run` is a tmpfs, but a socket anywhere else on the
  read-only root (one in the home directory, `/var/lib/…`) is still connectable — a read-only bind
  does not stop `connect()`. Seatbelt denies them (they are network-outbound).
- Linux hosts need `bubblewrap` (`sudo apt install bubblewrap`) and user namespaces that AppArmor
  allows; without either, pi is simply not offered there.
- pi does not become the default here. The condition: both platforms verified on real hardware —
  the Linux path on the Spark, by the owner (ROADMAP Next).
