import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESS_KINDS, type HarnessInfo, type HarnessKind } from '@agenthub/shared';

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
    // pi 0.73 prints its version on stderr, not stdout (verified, decision 0031); either stream
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

/**
 * What `GET /api/harnesses` reports. `builtin` is the hub itself and is always available;
 * `claude-code` is declared but not implemented yet (FR-G3), so it is never offered.
 */
export async function harnessStatus(): Promise<HarnessInfo[]> {
  const pi = await piBinary();
  const info: Record<HarnessKind, HarnessInfo> = {
    builtin: { kind: 'builtin', available: true },
    pi: { kind: 'pi', available: !!pi, ...(pi ? { version: pi.version } : {}) },
    'claude-code': { kind: 'claude-code', available: false },
  };
  return HARNESS_KINDS.map((kind) => info[kind]);
}
