# Mac mini node playbook (control node)

Default control node (spec §4.2). Runs the hub process and serves the
built UI — it does not serve any LLM tier.

## Setup

    git clone <repo> && cd AgentHub
    npm install
    npm run build:ui          # writes packages/ui/dist, served by the hub

## Daemon config

The Mac mini's node daemon has no `serving` entries with real models — if
this node also needs a daemon (e.g. for future browser-simulator jobs),
give it an empty-ish config; today it's simplest to just run the hub
directly, no node daemon required on the control node itself.

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
      </dict>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><true/>
    </dict></plist>

    launchctl load ~/Library/LaunchAgents/com.agenthub.hub.plist

## Future: Strix Halo switch

Spec §4.2 names the AMD Strix Halo box as a future alternate control node.
Switching (`/controlnode <name>`) checkpoints the DB, then rsyncs `data/`
(the SQLite DB plus project and memory file stores) over the tailnet to the
new control node before starting the hub there — `data/` is the only state
that needs to move. Until Strix Halo hardware exists, the Mac mini is the
only control node.
