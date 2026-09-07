# Telegram bot setup

The hub's Telegram bot is optional: with `TELEGRAM_BOT_TOKEN` or
`TELEGRAM_OWNER_CHAT_ID` unset, the hub logs one line and runs without it —
the assistant is still reachable over `/api/assistant/messages`. Nothing
here loads a `.env` file; set these in the environment the hub process
actually runs under (see `deploy/macmini/README.md`'s launchd plist).

## 1. Create the bot with BotFather

1. Open a chat with [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts (a display name, then a unique
   username ending in `bot`).
3. BotFather replies with an API token — that's `TELEGRAM_BOT_TOKEN`. Treat
   it like a password: anyone with it can send messages as your bot.

## 2. Find your Telegram user id

The hub only acts on updates whose *sender* is `TELEGRAM_OWNER_CHAT_ID` —
everyone else is silently ignored. This is your Telegram **user id**, not a
group or channel id: every update the bot receives (a message or a button
press) is keyed on who sent it, and the bot replies to that same id, which
is your private chat with it. A negative number is a group id and will never
match — the hub logs an error and starts without Telegram if you set one.

1. Open a chat with [@userinfobot](https://t.me/userinfobot) and send it any
   message. It replies with your account's `Id` — a positive number. That's
   `TELEGRAM_OWNER_CHAT_ID`.
2. Send your own bot a message too (search for its username, open the chat,
   send `hi`), so the private chat exists before the hub starts.

## 3. Set the environment and start the hub

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` (plus optionally
`BRIEFING_TIME`, `CHECKIN_TIMES`, `MEMORY_ROOT` — see the README's "Assistant
& Telegram" section) and start the hub. On the control node this normally
means adding them to the launchd unit's `EnvironmentVariables` dict, not a
`.env` file — see `deploy/macmini/README.md`.

## Voice notes (future)

Voice notes are not built in this phase. `OutgoingMessage` already carries an
optional `voice?: Buffer` field for it, and the shape of a future hookup is:

- A `VoiceAdapter` interface — `synthesize(text: string): Promise<Buffer>` —
  with a default no-op implementation (text-only replies, as today).
- A Kokoro TTS instance running as its own service (Kokoro is a small,
  local, GPU-optional TTS model), called from the adapter over HTTP.
- The `CommandRouter`/`Scheduler` would call the adapter when sending a
  reply and attach the resulting buffer as `OutgoingMessage.voice`;
  `GrammyPort.send` would upload it as a voice message when present.

Until that adapter exists, every reply is text.
