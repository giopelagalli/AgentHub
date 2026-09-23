# Parked ideas

## Review modules (learn by doing)
Spaced-repetition cards (SM-2, a daily 6pm session, a morning digest) are built in
`bot/scheduler/review.py`, `bot/study/srs.py` and the `Card` model, with tests, but are **not wired
in** (2026-09-17). Giovanni's direction: rather than flashcards in chat, build review as *modules*
you open — guided, do-the-thing exercises that teach exactly what you need for the next step,
on a learning platform. Re-wire the scheduler steps (`_review`, `_digest`), the `review_now`
tool and the `/review` command if the chat version is ever wanted back.

What stays live: exam → ordered day-by-day plan (`plan_exam`), study todos on the calendar,
check-ins asking "did you finish X", and a web lookup of what the subject usually covers when
no material has been dropped in.

## Telegram Mini App dashboard
One glanceable screen: do this next, today's timeline, due this week. Static page on the
existing App Platform site + an authenticated JSON endpoint on the droplet. After the study
platform has data worth showing.
