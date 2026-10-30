# Operating the hub

## Operating the hub (on the Spark)

Two systemd *user* units, installed from `deploy/spark/`:

| | |
|---|---|
| Hub | `agenthub-hub.service` — `systemctl --user status agenthub-hub` |
| Node daemon | `agenthub-node.service` |
| Logs | `journalctl --user -u agenthub-hub -f` (and `-u agenthub-node`) |
| Config | `~/AgentHub/configs/hub.env` — never committed |
| Data | `DATA_ROOT` (`~/agenthub-data`): `projects/<slug>/`, the hub database, memory, recordings |
| Update | `cd ~/AgentHub && git pull && npm run build:ui && systemctl --user restart agenthub-hub` |

**The terminal needs node-pty.** It ships prebuilt binaries for macOS and 64-bit Linux (the Spark
included), so a normal `npm ci` is all it takes. Anywhere else it compiles on install and needs
build tools — Xcode command line tools on a Mac (`xcode-select --install`), `build-essential` and
`python3` on Debian or Ubuntu. If `npm ci` fails on node-pty, that is what is missing; the hub does
not start without it.

**Restarting the hub cuts any running turn short.** Check the project toolbar for
`Running · m:ss` first, or expect a "cut short" briefing.

`hub.env` keys that matter:

| Key | What |
|---|---|
| `PORT`, `HUB_HOST` | Where the hub listens; `0.0.0.0` to reach it over Tailscale |
| `DATA_ROOT` | Everything the hub stores |
| `HUB_PASSWORD` | The login. `HUB_SESSION_SECRET` keeps you logged in across restarts |
| `DAEMON_TOKEN` | Shared secret every node daemon presents |
| `FIREWORKS_API_KEY` | Enables the `cloud-fireworks` node; `FIREWORKS_HARD_MODELS=1` unlocks the expensive tier |
| `MAX_TURNS_PER_DAY`, `AUTO_TURNS` | The hub-wide cap (default 24) and the scheduler kill switch (`0`) |
| `TURN_TIMEOUT_MINUTES` | How long a turn may run before it is cut short (default 45) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | The hub's own Telegram alerts (optional; JD is separate) |
| `GITHUB_APP_*` | The GitHub App behind **Connect GitHub** (below); `GITHUB_TOKEN` is the fallback |

**Registering the GitHub App (once).** This is what turns "Connect GitHub" on for everybody who
uses the hub. At **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Callback URL** `https://<your hub>/api/github/callback` — and the same URL as the **Setup URL**.
- Tick **Request user authorization (OAuth) during installation**, **Redirect on update** and
  **Expire user authorization tokens**.
- **Repository permissions**: Contents *Read and write*, Pull requests *Read and write*, Metadata
  *Read-only*. No webhook is needed.
- **Where can this app be installed**: any account, so members can connect their own.
- Generate a private key; a `.pem` downloads. Keep it beside `hub.env`, readable only by the hub's
  user (`chmod 600`).

Then five keys in `hub.env`, and a restart:

| Key | Where it comes from |
|---|---|
| `GITHUB_APP_ID` | the App's *App ID* |
| `GITHUB_APP_CLIENT_ID` | the App's *Client ID* (`Iv…`) |
| `GITHUB_APP_CLIENT_SECRET` | *Generate a client secret* on the App's page |
| `GITHUB_APP_SLUG` | the App's URL name — the last part of `github.com/apps/<slug>` |
| `GITHUB_APP_PRIVATE_KEY` | the **path** to the `.pem`, not its contents |

All five or none: with four of them the hub logs which one is missing and leaves Connect GitHub
off. It reads the `.pem` at startup, so an unreadable key is one clear line in the log rather than
a failure hours later. Nothing about the App is ever logged, and no token it mints reaches the
browser.

Backups: `DATA_ROOT` is the whole state. Every project folder is a git repo, so `git log` inside
`projects/<slug>` is the full history of that project.

When the Spark (and so the hub) is off, `rosenroot.com` does not answer with a bare 502: the
droplet's Caddy serves an offline page instead, with status 503 so monitors still see it as down.
The page polls the hub itself and reloads on its own once it is back.

The droplet also runs its own watchdog, independent of JD (which lives on the Spark and so is
silent for exactly the outage you'd want to hear about): every minute it checks the hub and sends
a Telegram message on the down/up transition only. Setup is `deploy/do/README.md` §8.

## Developing (the simulation)

To see or change the UI without the Spark, a login or any keys, run a whole AgentHub locally from
any checkout or worktree:

```sh
npm run sim       # hub on http://127.0.0.1:4100 (serves packages/ui/dist if it is built)
npm run sim:ui    # the same, plus the Vite dev server on http://localhost:5180 — open this one
```

The password is **`sim`**. The hub runs with auth on, scheduled turns off and no cloud tier; every
model is a scripted mock that answers as the manager, the employees, the PRD and roadmap leads and
the chats, with a small delay per token so a turn visibly streams. *Run turn* on `pomodoro-cli`
delegates the next milestone to Ada, runs the real tests, has Vex review it, and publishes a
briefing — and the mock is priced like Fireworks GLM, so costs show in dollars.

What is seeded, so every empty, partial and full state is on screen:

- **pomodoro-cli** — full PRD, 9 milestones with m1–m3 done and verified, two past turns with
  briefings and costs, five docs pages and a code map, a workspace (Code and Terminal have files),
  and a preview (a tiny static dashboard; press Start in Preview).
- **habit-tracker** — PRD drafted and roadmap generated, nothing built.
- **scratch** — just created; the PRD is the scaffold.
- **Nodes** — `sim-spark` online, serving the mock; `sim-pc` goes offline about 15 s after start.

Flags: `--port` (4100), `--ui-port` (5180), `--data <dir>` to keep the data between runs (seeded
only when empty), `--reset` to wipe it, `--token-delay <ms>` (30). Without `--data` the data lives
in a temp directory that is removed on exit. Ctrl-C stops everything. In the Browser pane, the
`sim` and `sim-ui` entries in `.claude/launch.json` start the same two commands.

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| *Waiting for the hub…* with a grey dot | The browser can't reach the hub | Is the hub running? `systemctl --user status agenthub-hub`; are you on the tailnet? |
| The login box | Session expired or a new browser | `grep HUB_PASSWORD ~/AgentHub/configs/hub.env` on the Spark |
| `listen EADDRINUSE :4000` in the log | Something else holds the port (a hub started by hand) | `ss -ltnp \| grep :4000`, kill it; systemd restarts the service |
| Node shows *offline* | Its daemon stopped heartbeating | On that machine: `systemctl --user status agenthub-node`, `journalctl --user -u agenthub-node -n 50` |
| Turn fails with `endpoint error 400 … Priority scheduling is not enabled` | vLLM lacks `--scheduling-policy priority` | Harmless: the hub drops the field and retries; to fix for real, set `EXTRA_VLLM_ARGS` in the recipe's `.env` and restart `sparkmodel` |
| `endpoint error 401/412` from Fireworks | Bad key / spending limit reached | Fix the key or the limit at app.fireworks.ai; local turns keep working |
| Run turn refused, "cap … reached" | Daily budget spent | Wait for the window, or raise `MAX_TURNS_PER_DAY` and restart |
| Briefing: "cut short" | Hub restarted or 45-minute (`TURN_TIMEOUT_MINUTES`) limit | Run the turn again; it resumes from the last briefing |
| Briefing: "hit its tool-call budget" | The milestone was too big for one turn | Split it in the Roadmap, or run again |
| Schedule suspended | Three consecutive errors | Find the error in Activity, fix it, switch *Run on its own* back on |

## Where things live

```
DATA_ROOT/
  hub.db                    the hub's database (nodes, jobs, transcripts, sessions)
  projects/<slug>/          one git repo per project
    manifest.yaml           title, status, order, model policy, auto-run, verifyCmd
    prd.md  roadmap.yaml    the plan
    project.md  tasks.yaml  the manager's board
    team.yaml               employees
    decisions.log.md        the why
    docs/                   the team's pages (code-map.md is Docs → How the code works)
    media/                  rendered images and clips, each with a .json of how it was made
    briefings/              one per turn
    workspace/              the code — its own git repo when the team inits one
  memory/                   the built-in assistant's notes
```
