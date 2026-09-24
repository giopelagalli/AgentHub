#!/bin/sh
# hub-watch.sh — polls the hub's /api/health from the droplet and sends a
# Telegram message when it goes down or comes back up. Run every minute by
# hub-watch.timer. See deploy/do/README.md §8.
set -eu

ENV_FILE="/etc/agenthub-watch.env"
if [ -f "$ENV_FILE" ]; then
	# shellcheck disable=SC1090,SC1091
	. "$ENV_FILE"
fi

STATE_DIR="${STATE_DIR:-/var/lib/agenthub-watch}"
STATE_FILE="$STATE_DIR/state"

HUB_UPSTREAM="${HUB_UPSTREAM:-}"
HUB_DOMAIN="${HUB_DOMAIN:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [ -z "$HUB_UPSTREAM" ]; then
	echo "hub-watch: HUB_UPSTREAM not set, skipping" >&2
	exit 0
fi

mkdir -p "$STATE_DIR"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$HUB_UPSTREAM/api/health" 2>/dev/null) || code="000"
if [ "$code" = "200" ]; then
	new_state="up"
else
	new_state="down"
fi

now=$(date +%s)

old_state="up"
old_time="$now"
if [ -f "$STATE_FILE" ]; then
	file_state=""
	file_time=""
	read -r file_state file_time < "$STATE_FILE" || true
	[ -n "$file_state" ] && old_state="$file_state"
	[ -n "$file_time" ] && old_time="$file_time"
fi

if [ "$new_state" = "$old_state" ]; then
	exit 0
fi

printf '%s %s\n' "$new_state" "$now" > "$STATE_FILE"

if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
	echo "hub-watch: state changed to $new_state (no Telegram credentials, not sending)" >&2
	exit 0
fi

if [ "$new_state" = "down" ]; then
	text="⛔ ${HUB_DOMAIN}: the hub is not answering (since $(date -u +%H:%M) UTC). The site shows the offline page."
else
	mins=$(( (now - old_time) / 60 ))
	text="✅ ${HUB_DOMAIN}: the hub is back (was down ${mins} min)."
fi

if ! curl -s -m 10 --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
	--data-urlencode "text=${text}" \
	"https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null; then
	echo "hub-watch: Telegram send failed" >&2
fi

exit 0
