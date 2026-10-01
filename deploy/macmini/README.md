# Mac mini node playbook (control node)

Default control node (spec §4.2). Runs the hub process, serves the built
UI, and hosts the shared browser (below) — by default it serves no LLM
tier.

## Setup

    git clone <repo> && cd AgentHub
    npm install
    npm run build:ui          # writes packages/ui/dist, served by the hub

## Daemon config

The control node normally runs no node daemon at all — just the hub
process above. The browser simulator below is the one thing that needs
one, and it can declare `browser: { enabled: true }` with no `serving`
entries at all: the daemon config validator only requires *some*
capability be declared (`config.ts` throws `daemon config: no capability
(serving, jobTypes, browser or controlNode) declared` when `serving`, `jobTypes` and
`browser` are all absent), and `browser` alone satisfies it. There is no
need for a stub `serving` entry — a stub endpoint would be registered
with the hub and routable by the gateway, taking agent traffic and
failing it.

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
        <key>DATA_ROOT</key><string>/Users/<you>/agenthub-data</string>
        <key>CONTROL_NODE_NAME</key><string>macmini</string>
        <key>PORT</key><string>4000</string>
        <key>HUB_HOST</key><string>100.x.y.z</string>
        <key>HUB_PASSWORD</key><string><the owner password></string>
        <key>HUB_SESSION_SECRET</key><string><openssl rand -hex 32></string>
        <key>DAEMON_TOKEN</key><string><the same token every daemon config carries></string>
        <key>TRUST_PROXY</key><string><the droplet's tailnet IP, see ../do/README.md §7></string>
        <key>TELEGRAM_BOT_TOKEN</key><string><from BotFather, see ../telegram.md></string>
        <key>TELEGRAM_OWNER_CHAT_ID</key><string><your Telegram user id, see ../telegram.md></string>
        <key>BRIEFING_TIME</key><string>08:00</string>
        <key>CHECKIN_TIMES</key><string>13:00,18:00</string>
      </dict>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><true/>
    </dict></plist>

`DATA_ROOT` is the one directory the hub owns; `HUB_DB`, `PROJECTS_ROOT`,
`MEMORY_ROOT` and the browser recordings all default to paths under it, and it
is what a control-node switch copies (`../controlnode.md`). `HUB_HOST` is the
address the hub binds: set it to **this machine's tailnet IP** so the hub is
not listening on every interface the Mac has — the default is `0.0.0.0`, which
is only right for local dev.

The **same** variables must be set on the standby control node's daemon too:
after a switch the new hub is spawned by that daemon and configured entirely
from what it passes through (the allowlist in `../controlnode.md`). A hub with
auth on refuses (412) to hand itself to a node that reports no `HUB_PASSWORD`.

The hub never loads a `.env` file — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_OWNER_CHAT_ID`
(and the rest of the assistant config) have to be set here, in the plist's
own `EnvironmentVariables`, not in a `.env` next to the repo. See
`../telegram.md` for getting a bot token and your chat id, and the README's
"Assistant & Telegram" section for what each variable does. With either
Telegram variable missing the hub still starts — it just runs without the
bot.

    launchctl load ~/Library/LaunchAgents/com.agenthub.hub.plist

## Browser simulator (spec §10)

This machine is also the cluster's browser: a headed Chromium driven by
Playwright, leased to one holder at a time by the hub, watched live in the
UI's Computer page. The browser lives in the *node daemon*, not the
hub, so the Mac mini runs both processes.

### Install Playwright + Chromium

Playwright is a dependency of no package in the repo — only this node
installs it, and `playwright-driver.ts` imports it through a non-literal
specifier so every other node runs the same daemon code without it:

    npm i -D -w @agenthub/node-daemon playwright
    npx playwright install chromium

To keep the ~500MB of browser binaries somewhere other than
`~/Library/Caches/ms-playwright`, set `PLAYWRIGHT_BROWSERS_PATH` — the same
value for the install *and* for the daemon process, or the daemon won't
find the browser it installed:

    export PLAYWRIGHT_BROWSERS_PATH=/Users/<you>/agenthub-data/playwright
    npx playwright install chromium

### Headed, on the dummy-HDMI display

`headless: false` launches Chromium with a real window, and the virtual-HDMI
dummy plug is what gives an otherwise displayless Mac mini somewhere to
render it — that window is what the screencast shows. Two consequences:

- The daemon must run as a **LaunchAgent** in a logged-in GUI session (the
  plist below). A LaunchDaemon has no window-server access and headed
  Chromium will fail to launch under one.
- Keep the display awake, or macOS stops compositing the window and frames
  go stale: `sudo pmset -a displaysleep 0 sleep 0`, or run the daemon under
  `caffeinate -dis`.

`headless: true` works fine and needs neither — the screencast still shows
the page — it just isn't a screen anyone can walk up to. The config's
`display` field exports `DISPLAY` to the browser process, which is for X11
nodes; leave it unset on macOS.

### Daemon config

    node: { name: macmini, arch: arm64 }
    # The tailnet alias, not a machine name: it follows the hub across a
    # control-node switch (../do/README.md §6, ../controlnode.md).
    hub: http://hub.internal:4000
    hubCandidates:
      - http://macmini.<tailnet>.ts.net:4000
      - http://strix.<tailnet>.ts.net:4000
    # No advertiseHost: the browser server stays on loopback (see below).
    jobTypes: ["browser-lease"]
    browser:
      enabled: true
      port: 8130                # default; 0 picks an ephemeral one
      headless: false
      slots: 1                  # isolated contexts in the one browser; up to 8 (FR-D8, 0059)

The daemon starts the browser server, then registers `browser: { url, slots }`
with the hub; the hub leases each `(node, slot)` of every online browser
node, one slot per project. Sessions
are recorded on the *hub* side, under `data/media/browser/<leaseId>/`
(`<seq>.jpg` + `actions.jsonl`), capped at 200 frames per lease.

**Security:** the browser server has no auth of its own until Phase 6 —
anything that can reach it can drive the browser. It binds `127.0.0.1`
unless `advertiseHost` is set, in which case it listens on the tailnet
address instead. The hub runs on this same machine, so leave
`advertiseHost` unset here and keep it on loopback; only set it if the hub
ever moves to another node (Strix Halo below), and understand that this
puts an unauthenticated browser-control API on the tailnet until the
daemon token lands.

### launchd plist for the node daemon (sketch)

    <!-- ~/Library/LaunchAgents/com.agenthub.node.plist -->
    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>com.agenthub.node</string>
      <key>ProgramArguments</key>
      <array>
        <string>npx</string><string>tsx</string>
        <string>packages/node-daemon/src/main.ts</string>
        <string>configs/macmini.yaml</string>
      </array>
      <key>WorkingDirectory</key><string>/Users/<you>/AgentHub</string>
      <key>EnvironmentVariables</key>
      <dict>
        <key>PLAYWRIGHT_BROWSERS_PATH</key><string>/Users/<you>/agenthub-data/playwright</string>
        <key>DAEMON_TOKEN</key><string><the same token the hub carries></string>
        <!-- On a control-node candidate, repeat the hub's own variables here too:
             this daemon is what spawns the hub after a switch. See ../controlnode.md. -->
      </dict>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><true/>
    </dict></plist>

    launchctl load ~/Library/LaunchAgents/com.agenthub.node.plist

## Future: Strix Halo switch

Spec §4.2 names the AMD Strix Halo box as a future alternate control node.
Switching (`/controlnode <name>`) pauses every writer, checkpoints the DB into
a `checkpoint.db` snapshot, then rsyncs `data/` (the snapshot plus the project
and memory file stores) over the tailnet to the new control node before
starting the hub there — `data/` is the only state that needs to move. The new
hub's configuration comes from the *target daemon's* environment, so set the
variables above on both machines. Until Strix Halo hardware exists, the Mac
mini is the only control node — see `../controlnode.md` for the full procedure.
