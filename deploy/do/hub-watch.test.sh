#!/bin/sh
# Exercises hub-watch.sh against a stubbed curl (down, then up) and checks
# the state file and the Telegram send text. Run: sh deploy/do/hub-watch.test.sh
set -eu

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/bin" "$dir/state"

cat > "$dir/bin/curl" <<STUB
#!/bin/sh
case "\$*" in
	*api.telegram.org*)
		echo "\$@" >> "$dir/telegram_calls"
		;;
	*)
		n=0
		[ -f "$dir/health_calls" ] && n=\$(cat "$dir/health_calls")
		n=\$((n + 1))
		echo "\$n" > "$dir/health_calls"
		[ "\$n" -eq 1 ] && printf '000' || printf '200'
		;;
esac
STUB
chmod +x "$dir/bin/curl"

script_dir=$(dirname -- "$0")

PATH="$dir/bin:$PATH"
export PATH
export STATE_DIR="$dir/state"
export HUB_UPSTREAM="127.0.0.1:1"
export HUB_DOMAIN="test.example"
export TELEGRAM_BOT_TOKEN="test-token"
export TELEGRAM_CHAT_ID="12345"

# Run 1: curl reports down (000) -> first-ever transition (default "up" -> "down").
sh "$script_dir/hub-watch.sh"
state1=$(cat "$dir/state/state")
case "$state1" in
	"down "*) ;;
	*) echo "FAIL: expected state 'down <epoch>' after run 1, got: $state1" >&2; exit 1 ;;
esac
grep -q "not answering" "$dir/telegram_calls" || { echo "FAIL: expected a down alert after run 1" >&2; exit 1; }

# Run 2: curl reports up (200) -> transition back.
sh "$script_dir/hub-watch.sh"
state2=$(cat "$dir/state/state")
case "$state2" in
	"up "*) ;;
	*) echo "FAIL: expected state 'up <epoch>' after run 2, got: $state2" >&2; exit 1 ;;
esac
grep -q "hub is back" "$dir/telegram_calls" || { echo "FAIL: expected an up alert after run 2" >&2; exit 1; }

echo "ok: hub-watch.sh state transitions and Telegram send text verified"
