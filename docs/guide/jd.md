# JD

## Talking to JD in the hub

**JD** at the top of the sidebar is your assistant — the same JD as on Telegram — in the hub,
on a laptop or a phone. Type, or tap the mic to record a voice note (tap ↑ to send it, × to
throw it away); JD answers in text, and sometimes out loud with a small player in its bubble.
Buttons under JD's message work like Telegram's, and the chips over the field are JD's quick keys.
What you say here is in JD's memory, but it does not show up in the Telegram chat (a bot cannot
post as you); JD's briefings and check-ins arrive in both places.

To connect it, once, on the Spark:

1. Make a token: `openssl rand -hex 32`.
2. Put the same value in **both** env files as `JD_WEB_TOKEN=<token>` — `~/telegramManager/.env`
   (JD's) and `~/AgentHub/configs/hub.env` (the hub's; it is the file the hub's unit reads).
3. In the hub's `hub.env`, also: `JD_URL=http://127.0.0.1:8891`.
4. Restart both: JD, and the hub (`systemctl --user restart agenthub-hub`).

Until then the JD page shows those two lines and nothing else. Otherwise it tells you what is wrong:

- **Set a hub password first** — `JD_URL` is set but the hub has no `HUB_PASSWORD`; the door to JD
  stays shut on a hub anyone could reach.
- **The token doesn't match** — JD is running but refused the hub's token: the two `JD_WEB_TOKEN`s
  differ.
- **JD isn't answering** — JD is not running or is on another port. In the middle of a
  conversation this shows as "Not answering — retrying…" under JD's name, and it reconnects by
  itself.

Changing the token later is the same two edits and two restarts. Voice notes need the hub over
HTTPS (the public site); over plain HTTP on the tailnet the mic says so instead.
