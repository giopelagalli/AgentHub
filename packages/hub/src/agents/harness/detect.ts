import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESS_KINDS, type HarnessInfo, type HarnessKind } from '@agenthub/shared';
import { secretsStripped } from '@agenthub/shared/shell';
import { sandboxStatus } from './sandbox.js';

const run = promisify(execFile);

/** Long enough for a cold `node dist/cli.js --version`, short enough not to hold up a page load. */
const VERSION_TIMEOUT_MS = 5000;

/**
 * Detection is "is the CLI on PATH": the hub runs an external harness as a subprocess, so the only
 * question that matters is whether spawning it will work. `--version` answers that and names the
 * version in the same call; anything else (not installed, not executable, hangs) reads as absent.
 */
async function cliVersion(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS });
    // pi 0.73 prints its version on stderr, not stdout (verified, decision 0049); either stream
    // counts, because the question being answered is "did it run", not "what did it say where".
    const line = (stdout.trim() || stderr.trim()).split('\n')[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** The pi CLI, when this host has one. `path` is what the adapter spawns. */
export async function piBinary(): Promise<{ path: string; version: string } | null> {
  const version = await cliVersion('pi');
  return version ? { path: 'pi', version } : null;
}

/** The claude CLI, when this host has one. `path` is what the adapter spawns. */
export async function claudeBinary(): Promise<{ path: string; version: string } | null> {
  const version = await cliVersion('claude');
  return version ? { path: 'claude', version } : null;
}

/**
 * Whether the claude CLI on this host is signed in to a Claude subscription. `claude auth status`
 * answers locally, without a model call (verified with claude 2.1, decision 0064): JSON with
 * `loggedIn` and `authMethod`, which is `claude.ai` for a subscription login. An API-key login is
 * refused, because the owner's rule is the subscription and never the API. Asked with the same
 * stripped environment a run gets, so a hub `ANTHROPIC_API_KEY` cannot make it look signed in.
 * Output that cannot be read leaves the login unverified rather than refused: the first run then
 * fails with the CLI's own message.
 */
export async function claudeLogin(bin: string): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> {
  let out = '';
  try {
    out = (await run(bin, ['auth', 'status', '--json'], { timeout: VERSION_TIMEOUT_MS, env: secretsStripped() })).stdout;
  } catch (err) {
    // A signed-out CLI may say so and exit non-zero; what it printed is still the answer.
    out = String((err as { stdout?: unknown }).stdout ?? '');
  }
  let status: { loggedIn?: unknown; authMethod?: unknown };
  try { status = JSON.parse(out) as typeof status; } catch { return { ok: true, note: 'login not verified' }; }
  if (status.loggedIn === false) {
    return { ok: false, reason: 'claude is not signed in on this host: run `claude` once in a terminal there and log in' };
  }
  if (status.loggedIn !== true) return { ok: true, note: 'login not verified' };
  if (status.authMethod !== 'claude.ai') {
    return { ok: false, reason: `claude is signed in with ${String(status.authMethod)}, not a Claude subscription` };
  }
  return { ok: true };
}

export type ClaudeCodeStatus =
  | { available: true; bin: string; version: string; note?: string }
  | { available: false; version?: string; reason: string };

/** How long a found-available claude-code is believed without asking the CLI again (~1 s a check). */
const CLAUDE_STATUS_TTL_MS = 60_000;
let claudeAvailable: { at: number; status: ClaudeCodeStatus } | undefined;

/** Drops the cached answer, so the next `claudeCodeStatus` asks the CLI. For tests. */
export function forgetClaudeCodeStatus(): void { claudeAvailable = undefined; }

/**
 * Whether claude-code can run here, and why not: the CLI on PATH, signed in to a subscription, and
 * a host that can sandbox it with outbound HTTPS (decision 0064). A success holds for a minute,
 * because `auth status` takes about a second and the Harness list asks on every load; a failure is
 * asked again next time, so signing in on the host shows up at once.
 */
export async function claudeCodeStatus(): Promise<ClaudeCodeStatus> {
  if (claudeAvailable && Date.now() - claudeAvailable.at < CLAUDE_STATUS_TTL_MS) return claudeAvailable.status;
  claudeAvailable = undefined;
  const status = await probeClaudeCode();
  if (status.available) claudeAvailable = { at: Date.now(), status };
  return status;
}

async function probeClaudeCode(): Promise<ClaudeCodeStatus> {
  const bin = await claudeBinary();
  if (!bin) return { available: false, reason: 'claude is not installed on this host' };
  const login = await claudeLogin(bin.path);
  if (!login.ok) return { available: false, version: bin.version, reason: login.reason };
  const sandbox = await sandboxStatus({ https: true });
  if (!sandbox.available) return { available: false, version: bin.version, reason: `claude-code cannot be sandboxed on this host: ${sandbox.reason}` };
  return { available: true, bin: bin.path, version: bin.version, ...(login.note ? { note: login.note } : {}) };
}

/**
 * What `GET /api/harnesses` reports. `builtin` is the hub itself and is always available; pi only
 * when it is installed *and* this host can sandbox it (decision 0055) — it never runs unconfined.
 * `claude-code` when its CLI is installed, signed in to a subscription and sandboxable (decision 0064).
 */
export async function harnessStatus(doorBase?: string | null): Promise<HarnessInfo[]> {
  const [pi, claude] = await Promise.all([piBinary(), claudeCodeStatus()]);
  // Without a base (the hub is not listening yet) only the host is judged; a run checks the door again.
  const sandbox = pi ? await sandboxStatus(doorBase ? { doorBase } : {}) : undefined;
  const refused = sandbox && !sandbox.available ? `pi cannot be sandboxed on this host: ${sandbox.reason}` : undefined;
  const info: Record<HarnessKind, HarnessInfo> = {
    builtin: { kind: 'builtin', available: true },
    pi: {
      kind: 'pi', available: !!pi && !refused,
      ...(pi ? { version: pi.version } : {}),
      ...(refused ? { reason: refused } : {}),
    },
    'claude-code': {
      kind: 'claude-code', available: claude.available,
      ...(claude.version ? { version: claude.version } : {}),
      ...('reason' in claude ? { reason: claude.reason } : 'note' in claude && claude.note ? { reason: claude.note } : {}),
    },
  };
  return HARNESS_KINDS.map((kind) => info[kind]);
}
