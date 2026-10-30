#!/usr/bin/env bash
# One-command deploy on the Spark: pull AgentHub and JD, install, build, restart, check.
#
#   ~/AgentHub/deploy/spark/deploy.sh
#
# Asks for sudo once, for JD's system service. The hub and node are user units. A node daemon
# that is stopped on purpose (models paused, 0074) stays stopped. Safe to rerun.
set -euo pipefail

# Everything runs inside main so bash has read the whole script before `git pull` can change it.
main() {
  local hub="${AGENTHUB_DIR:-$HOME/AgentHub}" jd="${JD_DIR:-$HOME/telegramManager}"
  step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

  step "AgentHub: pull"
  git -C "$hub" pull --ff-only
  step "AgentHub: install and build the UI"
  (cd "$hub" && npm install --no-audit --no-fund --loglevel=error && npm run build:ui --silent)

  if [ -d "$jd/.git" ]; then
    step "JD: pull"
    git -C "$jd" pull --ff-only
    step "JD: install"
    "$jd/.venv/bin/pip" install -q -e "$jd"
  fi

  step "Restart"
  systemctl --user restart agenthub-hub
  systemctl --user try-restart agenthub-node
  if [ -d "$jd/.git" ]; then sudo systemctl restart assistant; fi

  step "Check"
  local port
  port="$(grep -E '^PORT=' "$hub/configs/hub.env" 2>/dev/null | cut -d= -f2 || true)"
  port="${port:-4000}"
  local ok=""
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ -n "$ok" ]; then echo "hub      up on :$port  ($(git -C "$hub" log -1 --format='%h %s'))"
  else echo "hub      NOT answering on :$port — journalctl --user -u agenthub-hub -n 50"; fi
  echo "node     $(systemctl --user is-active agenthub-node || true)"
  if [ -d "$jd/.git" ]; then
    echo "JD       $(systemctl is-active assistant || true)  ($(git -C "$jd" log -1 --format='%h %s'))"
  fi
  [ -n "$ok" ]
}

main "$@"
