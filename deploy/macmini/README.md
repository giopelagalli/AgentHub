# Mac mini node playbook (control node)

Default control node (spec §4.2). Runs the hub process and serves the
built UI — it does not serve any LLM tier.

## Setup

    git clone <repo> && cd AgentHub
    npm install
    npm run build:ui          # writes packages/ui/dist, served by the hub

## Daemon config

The control node normally runs no node daemon at all — just the hub
process above. If one is ever needed here (e.g. for future
browser-simulator jobs), note that the daemon config validator requires
at least one `serving` entry (`config.ts` throws `daemon config: serving
missing` on an empty or missing list) — a real `serving` entry, not an
empty one, would be required.

## launchd plist for the hub (sketch)

    <!-- ~/Library/LaunchAgents/com.agenthub.hub.plist -->
    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>com.agenthub.hub</string>
      <key>ProgramArguments</key>
      <array>
        <string>npx</string><string>tsx</string>
        <string>packages/hub/src/main.ts</string>
      </array>
      <key>WorkingDirectory</key><string>/Users/<you>/AgentHub</string>
      <key>EnvironmentVariables</key>
      <dict>
        <key>HUB_DB</key><string>/Users/<you>/agenthub-data/hub.db</string>
        <key>PORT</key><string>4000</string>
        <key>MEMORY_ROOT</key><string>/Users/<you>/agenthub-data/memory</string>
        <key>TELEGRAM_BOT_TOKEN</key><string><from BotFather, see ../telegram.md></string>
        <key>TELEGRAM_OWNER_CHAT_ID</key><string><your chat id, see ../telegram.md></string>
        <key>BRIEFING_TIME</key><string>08:00</string>
        <key>CHECKIN_TIMES</key><string>13:00,18:00</string>
      </dict>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><true/>
    </dict></plist>

The hub never loads a `.env` file — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_OWNER_CHAT_ID`
(and the rest of the assistant config) have to be set here, in the plist's
own `EnvironmentVariables`, not in a `.env` next to the repo. See
`../telegram.md` for getting a bot token and your chat id, and the README's
"Assistant & Telegram" section for what each variable does. With either
Telegram variable missing the hub still starts — it just runs without the
bot.

    launchctl load ~/Library/LaunchAgents/com.agenthub.hub.plist

## Future: Strix Halo switch

Spec §4.2 names the AMD Strix Halo box as a future alternate control node.
Switching (`/controlnode <name>`) checkpoints the DB, then rsyncs `data/`
(the SQLite DB plus project and memory file stores) over the tailnet to the
new control node before starting the hub there — `data/` is the only state
that needs to move. Until Strix Halo hardware exists, the Mac mini is the
only control node.
