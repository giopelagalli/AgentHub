# The API

## Using the hub as an API

The hub speaks OpenAI. Anything that can point at an OpenAI-compatible base URL — JD, pi, the
`openai` SDK, plain `curl` — can use your nodes through it, with the hub's routing, the hub's
spend cap, and one line per request in the same cost ledger Machines shows.

**A token.** **Machines → Access → API tokens** → a label and a kind → **Create token**. The token
(`ah_…`) is shown once and never again; the hub keeps only a hash. Revoke it from the same list
and it stops working immediately.

**The two kinds** set the request's priority on a shared server (the Spark runs one model for
everyone):

| Kind | For | vLLM priority |
|---|---|---|
| `assistant` | something you are waiting on — JD, a chat client | 0 (first in line) |
| `agent` | something running by itself — a coding harness, a batch | 10 (yields to the above) |

**The base URL** is the hub's, plus `/v1`: `https://rosenroot.com/v1` from outside,
`http://<hub>:4000/v1` on the tailnet. Bad tokens are locked out per client address after five
tries, so behind the droplet's proxy `TRUST_PROXY` must be set (`configs/hub.env`) or every
outside client counts as one — a valid token is never affected either way.

```sh
curl https://rosenroot.com/v1/chat/completions \
  -H "Authorization: Bearer ah_…" -H "content-type: application/json" \
  -d '{"model":"agenthub/worker","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

**The models.** `GET /v1/models` lists the two that matter:

- `agenthub/orchestrator` — the thinking tier.
- `agenthub/worker` — the working tier.

Both are *tiers*, not models: the hub picks the node, exactly as it does for a project's turns,
and the response's `model` field says what actually served it. A concrete model id that is
serving right now also works — a cloud id routes to that provider, a local id stays local.
A tier name also takes a route suffix: `agenthub/worker@local` (local only — a 503 rather than a
cloud bill when nothing local is serving), `@cloud`, or a provider such as `@fireworks`.

Streaming and non-streaming both work, as do `tools` and `tool_calls`; ask for
`stream_options: {"include_usage": true}` and the last chunk carries the token counts. Fields the
hub has no use for (`temperature`, `max_tokens`, …) are accepted and ignored. Spend through the
door counts against `MAX_CLOUD_USD_PER_DAY` like everything else, and shows on the cloud-spend line
in Machines → Nodes.

### Driving projects with an assistant token

An `assistant` token also opens a short, fixed list of the hub's own `/api` routes, so JD (or a
script of yours) can start and steer projects the way you do from the UI (0065). Nothing else:
tokens, nodes, enrollment, GitHub, the terminal, previews, code edits, media and the browser stay
yours alone. An `agent` token gets **403** on these routes — agents never create projects or start
turns. Bad tokens share the door's lockout (five tries per address, then 429).

| Route | What it does |
|---|---|
| `GET /api/state` | the whole hub: nodes, jobs, projects with their last turn |
| `GET /api/briefings` | every project's latest briefing |
| `GET /api/projects` | every project's manifest |
| `GET /api/projects/:slug/turns?since=<ms>` | recent turns; with `since`, only those that ended at or after it |
| `POST /api/projects` | create — `{slug, title, intent, idea?, priority?}`; importing a repo (`source`) stays yours (403) |
| `POST /api/projects/:slug/prd/draft?wait=1` | draft the PRD from the idea; `wait=1` answers JSON instead of a stream |
| `POST /api/projects/:slug/roadmap/generate?wait=1` | turn the PRD into milestones, same `wait=1` |
| `POST /api/projects/:slug/turn` | run one turn — `{instruction?}`; answers with the briefing when it lands |
| `POST /api/projects/:slug/pause` / `resume` | stop / restart scheduling |
| `POST /api/projects/:slug/priority` | `{priority: "interactive" \| "project" \| "batch"}` |

Whatever a token does is signed with its label: commits say `(by JD)`, and a turn it started
carries `"requestedBy": "JD"` in `/turns`, so it can tell its own turns from yours (0067).

```sh
H='Authorization: Bearer ah_…'; J='content-type: application/json'; HUB=http://<hub>:4000
# create, then draft (a model run: give it minutes, not seconds)
curl -sX POST $HUB/api/projects -H "$H" -H "$J" \
  -d '{"slug":"tide-clock","title":"Tide clock","intent":"a tide clock for the harbour","idea":"…"}'
curl -sX POST "$HUB/api/projects/tide-clock/prd/draft?wait=1" -H "$H" -H "$J" -d '{}'
curl -sX POST "$HUB/api/projects/tide-clock/roadmap/generate?wait=1" -H "$H" -H "$J" -d '{}'
# run a turn; hanging up does not stop it, so fire it and poll
since=$(($(date +%s) * 1000))
curl -sX POST $HUB/api/projects/tide-clock/turn -H "$H" -H "$J" -d '{"instruction":"start on m1"}' --max-time 5
curl -s "$HUB/api/projects/tide-clock/turns?since=$since" -H "$H"   # → turns[0].summary when it lands
```

A hanging-up client does stop a `?wait=1` draft (as a closed stream does), but not a turn; the hub
gives up on a `?wait=1` run itself after 10 minutes (504). On a
hub started without a password (the dev sim) nothing is checked and nothing is signed.
