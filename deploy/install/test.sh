#!/bin/sh
# Smoke tests for deploy/install.sh. Runs the installer with --dry-run (so nothing on this machine
# changes) and greps the output for the lines each path must print. Exits non-zero on a mismatch.
#
#     sh deploy/install/test.sh
#
# Deliberately outside vitest: this tests a shell script, and a node must be installable without
# the repo's test tooling.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALL=$HERE/../install.sh
TMP=${TMPDIR:-/tmp}/agenthub-install-test.$$
HUB=https://hub.invalid:4000
FAILURES=0
CASE=''

mkdir -p "$TMP"
# shellcheck disable=SC2329  # invoked by the trap below
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() { printf 'FAIL [%s] %s\n' "$CASE" "$1" >&2; FAILURES=$((FAILURES + 1)); }
pass() { printf 'ok   [%s] %s\n' "$CASE" "$1"; }

# expect <file> <pattern> — the output must contain a line matching pattern.
expect() {
  if grep -q -- "$2" "$1"; then pass "$2"; else fail "expected /$2/ in the output"; fi
}
# reject <file> <pattern> — the output must NOT contain it.
reject() {
  if grep -q -- "$2" "$1"; then fail "did not expect /$2/ in the output"; else pass "no /$2/"; fi
}

# run_installer <outfile> <args...>
run_installer() {
  ri_out=$1
  shift
  if AGENTHUB_HOME=$TMP/home sh "$INSTALL" "$@" > "$ri_out" 2>&1; then
    return 0
  fi
  fail "the installer exited $? — output:"
  sed 's/^/    | /' "$ri_out" >&2
  return 1
}

# ---------------------------------------------------------------- syntax

CASE=syntax
if sh -n "$INSTALL"; then pass 'sh -n'; else fail 'sh -n failed'; fi
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s sh "$INSTALL"; then pass 'shellcheck'; else fail 'shellcheck reported problems'; fi
else
  printf 'skip [syntax] shellcheck is not installed\n'
fi

# ---------------------------------------------------------------- the whole plan, compute-only

CASE=dry-run
OUT=$TMP/dry-run.txt
if run_installer "$OUT" --hub "$HUB" --token TEST-ENROLLMENT-TOKEN --dry-run --recipe none; then
  expect "$OUT" '^==> Detecting this machine'
  expect "$OUT" '^==> Checking Node.js'
  expect "$OUT" '^==> Fetching the daemon from '"$HUB"'/install/agenthub-src.tgz'
  expect "$OUT" '^==> Choosing a serving recipe'
  expect "$OUT" '^==> Writing .*/node.yaml'
  expect "$OUT" '^==> Enrolling with '"$HUB"
  expect "$OUT" '^==> Waiting for the daemon to come up'
  expect "$OUT" 'recipe: none - registering compute-only'
  expect "$OUT" '| serving: \[\]'
  expect "$OUT" '| jobTypes: \["shell-task"\]'
  expect "$OUT" '| claimIntervalMs: 1000'
  expect "$OUT" '\[dry-run\] POST '"$HUB"'/api/nodes/enroll'
  # The enrollment token must never be echoed, and neither must an unmasked node token.
  reject "$OUT" 'TEST-ENROLLMENT-TOKEN'
  # --dry-run changes nothing, so it must not create its AGENTHUB_HOME.
  if [ -e "$TMP/home" ]; then fail "--dry-run created $TMP/home"; else pass '--dry-run touched nothing'; fi
fi

# ---------------------------------------------------------------- per-OS service + hardware class

CASE=platform
OUT=$TMP/platform.txt
if run_installer "$OUT" --hub "$HUB" --token T --dry-run --recipe none; then
  case "$(uname -s)" in
    Darwin)
      expect "$OUT" '^==> Installing the launchd agent (ai.agenthub.node)'
      expect "$OUT" 'LaunchAgents/ai.agenthub.node.plist'
      expect "$OUT" '<string>packages/node-daemon/src/main.ts</string>'
      expect "$OUT" 'node_modules/.bin/tsx'
      case "$(uname -m)" in
        arm64) expect "$OUT" 'gpu class: apple-silicon-' ;;
      esac
      ;;
    Linux)
      expect "$OUT" '^==> Installing the systemd user unit'
      expect "$OUT" 'systemd/user/agenthub-node.service'
      expect "$OUT" 'ExecStart=.*node_modules/.bin/tsx packages/node-daemon/src/main.ts'
      ;;
  esac
fi

# ---------------------------------------------------------------- attach, against a fake server

CASE=attach
if command -v python3 >/dev/null 2>&1; then
  python3 "$HERE/fake-openai-server.py" 8001 fake-model-7b > "$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  ready=0
  tries=0
  while [ "$tries" -lt 30 ]; do
    if curl -fsS -m 1 http://127.0.0.1:8001/v1/models > /dev/null 2>&1; then ready=1; break; fi
    tries=$((tries + 1))
    sleep 0.2
  done
  if [ "$ready" -eq 0 ]; then
    printf 'skip [attach] could not start the fake server on :8001 (something else listening?)\n'
  else
    OUT=$TMP/attach.txt
    if run_installer "$OUT" --hub "$HUB" --token T --dry-run --recipe attach --yes; then
      expect "$OUT" 'found "fake-model-7b" on port 8001'
      expect "$OUT" 'recipe: attach'
      expect "$OUT" '| serving:'
      expect "$OUT" '|   - tier: worker'
      # One server, so it serves the orchestrator tier too.
      expect "$OUT" '|   - tier: orchestrator'
      expect "$OUT" '|     model: fake-model-7b'
      expect "$OUT" '|     port: 8001'
      expect "$OUT" '|     maxStreams: 2'
      # The regression that prompted this case: a serving block with no trailing newline glued
      # jobTypes onto the last entry.
      expect "$OUT" '^    | jobTypes: \["shell-task"\]'
      reject "$OUT" 'maxStreams: 2jobTypes'
    fi
  fi
  kill "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=''
else
  printf 'skip [attach] python3 is not installed\n'
fi

# ---------------------------------------------------------------- argument handling

CASE=args
OUT=$TMP/args.txt
if AGENTHUB_HOME=$TMP/home sh "$INSTALL" --token T --dry-run > "$OUT" 2>&1; then
  fail 'a missing --hub should exit non-zero'
else
  expect "$OUT" '\-\-hub is required'
fi
if AGENTHUB_HOME=$TMP/home sh "$INSTALL" --hub "$HUB" --dry-run > "$OUT" 2>&1; then
  fail 'a missing --token on a fresh machine should exit non-zero'
else
  expect "$OUT" '\-\-token is required'
fi
if AGENTHUB_HOME=$TMP/home sh "$INSTALL" --hub "$HUB" --token T --recipe nope --dry-run > "$OUT" 2>&1; then
  fail 'an unknown --recipe should exit non-zero'
else
  expect "$OUT" 'unknown --recipe nope'
fi

# ---------------------------------------------------------------- update path (no enrollment)

CASE=update
mkdir -p "$TMP/home"
cat > "$TMP/home/node.yaml" <<'EXISTING'
node:
  name: already-here
  arch: arm64
hub: https://hub.invalid:4000
hubToken: "an-existing-node-token"
serving: []
jobTypes: ["shell-task"]
EXISTING
OUT=$TMP/update.txt
# No --token: an installed node updates in place.
if run_installer "$OUT" --hub "$HUB" --dry-run --recipe none; then
  expect "$OUT" '^==> Updating the node already installed'
  expect "$OUT" 'already enrolled - keeping the existing node token'
  expect "$OUT" 'name: already-here'
  reject "$OUT" '\[dry-run\] POST'
  reject "$OUT" 'an-existing-node-token'
fi

# ---------------------------------------------------------------- uninstall

CASE=uninstall
OUT=$TMP/uninstall.txt
if run_installer "$OUT" --uninstall --dry-run --yes; then
  expect "$OUT" '^==> Uninstalling the AgentHub node'
  expect "$OUT" 'Remove the node from the hub'"'"'s Cluster page'
fi

# ----------------------------------------------------------------

if [ "$FAILURES" -eq 0 ]; then
  printf '\nall install.sh checks passed\n'
  exit 0
fi
printf '\n%s install.sh check(s) failed\n' "$FAILURES" >&2
exit 1
