# AgentHub — notes for agents

TypeScript ESM npm workspaces: `packages/shared`, `mocks`, `hub` (Fastify +
SQLite), `node-daemon`, `ui` (Vite, vanilla TS). Tests are vitest; UI tests
are `*.dom.test.ts` on happy-dom.

## Fast paths

- **Fresh worktree:** run `npm install --prefer-offline --no-audit --no-fund`
  first. Without it `tsx` is missing and `@agenthub/*` resolves to the main
  checkout, so tests fail for reasons that aren't yours.
- **One test file:** `npx vitest run packages/hub/test/<name>.test.ts`.
- **Typecheck:** `npm run typecheck`.
- **Full suite** (~50 s): the main session runs it once before merge. Builders
  don't.
- **Deploy to the Spark:** the owner runs `~/AgentHub/deploy/spark/deploy.sh`
  (pulls the hub and JD, installs, builds, restarts, checks).
- **See it running:** `npm run sim:ui` starts a seeded hub and UI with fake
  machines and projects; password `sim`; it prints its URLs. Run one sim at a
  time and stop it when done.

## Records

- Decisions live in `docs/decisions/NNNN-slug.md`; the main session hands out
  numbers. The owner-facing guide is one page per topic: update the page in
  `docs/guide/` for what you changed. Don't edit `docs/ROADMAP.md` or `docs/CHANGELOG.md`.

## Owner rules in force

- Generation runs on Fireworks' cheap models; hard models stay off (0002,
  0074). The Spark's local model is paused for the hub.
- Claude runs only through the signed-in subscription CLI, never the API
  (0064).
- Local-only projects never send work off the cluster.
- Secrets are generated on the machine that uses them and never pasted into
  chat.
