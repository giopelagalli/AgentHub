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

## 2. Find your chat id

The hub only acts on messages from `TELEGRAM_OWNER_CHAT_ID` — every other
chat is silently ignored, so this has to be your own id, not the bot's.

1. Send any message to your new bot (search for its username, open the chat,
   send `hi`).
2. Fetch `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` (in a
   browser or with `curl`) and look for `message.chat.id` in the response —
   that number (it may be negative for a group) is `TELEGRAM_OWNER_CHAT_ID`.
   If the response is empty, send the bot another message and retry — Telegram
   only returns updates it hasn't handed out yet.

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
