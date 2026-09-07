# External APIs

Four named tools across three services are the only way an AgentHub agent can
reach the outside world *over HTTP* (PRD §12). There is no generic `fetch`
tool, and there never should be: no agent tool makes an unaudited HTTP call —
if a capability is not one of the tools below, no agent can perform it.

The residual hole is `run_shell`, the project-workspace tool: a command it runs
can open its own socket, and the tool belt cannot see that. If that matters for
your threat model, sandbox it at the OS/network level (a `nobody`-style user
with an egress-denied firewall group, a container, or a per-node outbound
allowlist) — the tool belt is not where it can be closed.

Every call is bounded by a 15s timeout and writes one `tool_audit` row
(timestamp, session, tool, purpose, request/response bytes, ok). Read the
ledger with `GET /api/audit?limit=` as the owner.

Keys live in the environment of the hub process on the control node only —
node daemons never receive them. A key that is not set removes its tool and
costs one log line at startup; the hub still runs.

## grok_query — xAI

    POST https://api.x.ai/v1/chat/completions
    Authorization: Bearer $XAI_API_KEY
    { "model": "grok-4", "messages": [{ "role": "user", "content": "<prompt>" }] }

OpenAI-shaped; the answer is `choices[0].message.content`. Model override:
`XAI_MODEL`. Key: console.x.ai.

## post_to_x — X (Twitter) API v2

    POST https://api.x.com/2/tweets
    Authorization: Bearer $X_API_KEY
    { "text": "<post>" }

A different service from xAI with its own credential: `X_API_KEY` is an X API
v2 **user-context** token with `tweet.write` (developer.x.com → project → user
authentication settings). App-only (bearer) tokens cannot post.

Mind which user-context flavour you paste in: an OAuth2 access token obtained
by hand expires in about two hours, so the tool works once and then 401s. Use
either OAuth 1.0a user-context credentials (long-lived, but they must be signed
per request — that needs a signing step this hub does not implement yet) or
OAuth2 with a refresh token and a refresher that keeps `X_API_KEY` current.
Until one of those is wired up, treat `post_to_x` as a manual-token tool and
expect to re-paste it.

With `X_API_KEY` unset the tool falls back to `XAI_API_KEY`, which will fail
against the X API — set the right one.

`post_to_x` is the hub's only **outward** tool: it never posts when the model
calls it. It proposes the post through the confirmation gate and returns
`pending confirmation <id>`; the post happens only when the owner confirms
(`POST /api/assistant/pending/:id/confirm`, or the inline Confirm button in
Telegram). The audit row is written when the post is actually sent.

## youtube_understand — Gemini

    POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
    x-goog-api-key: $GEMINI_API_KEY
    { "contents": [{ "parts": [
        { "file_data": { "file_uri": "https://www.youtube.com/watch?v=..." } },
        { "text": "<question>" }
    ] }] }

Gemini fetches the video itself: only the URL and the question leave the
machine, never video bytes. The answer is the concatenated
`candidates[0].content.parts[].text`. The tool refuses a URL that is not a
YouTube video URL without calling out. Model override: `GEMINI_MODEL`. Key:
aistudio.google.com.

## web_search — Brave or Tavily

`SEARCH_PROVIDER` picks one; `SEARCH_API_KEY` is that provider's key.

    GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=<n>
    X-Subscription-Token: $SEARCH_API_KEY
    → web.results[] { title, url, description }

    POST https://api.tavily.com/search
    Authorization: Bearer $SEARCH_API_KEY
    { "query": "<query>", "max_results": <n> }
    → results[] { title, url, content }

Either way the tool returns `[{ title, url, snippet }]`.

## Everything else

The hub's other outbound traffic is not agent-driven and is not part of this
policy surface: Telegram (bot API, owner chat only) and ComfyUI plus the node
daemons' own endpoints, which are on the tailnet, not the internet.
