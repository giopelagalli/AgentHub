import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';

/**
 * A daemon has to follow the hub when a control-node switch moves it (FIX-4). The tailnet alias is
 * the real mechanism — `hub.internal` is repointed and nothing in the config changes — and
 * `hubCandidates` is the backstop this exercises, since a test can't repoint DNS.
 */

const dirs: string[] = [];
const hubs: Hub[] = [];
let daemon: Daemon | undefined;

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-rediscover-'));
  dirs.push(dir);
  return dir;
}

async function startHub(): Promise<{ hub: Hub; url: string }> {
  const hub = createHub({ staleMs: 60_000, projectsRoot: join(tmpDir(), 'projects') });
  hubs.push(hub);
  await hub.projects.stop();
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  return { hub, url: `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}` };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  for (const hub of hubs) await hub.stop();
  hubs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('daemon hub rediscovery', () => {
  it('moves to the next candidate once the hub it was talking to stops answering', async () => {
    const first = await startHub();
    const second = await startHub();

    const dir = tmpDir();
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: follower', '  arch: arm64',
      `hub: ${first.url}`,
      'hubCandidates:',
      `  - ${second.url}`,
      'hubToken: daemon-tok',
      'heartbeatMs: 50',
      'claimIntervalMs: 50',
      `workspaceRoot: ${join(dir, 'workspace')}`,
      'jobTypes: [shell-task]',
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();
    expect(first.hub.registry.byName('follower')?.status).toBe('online');
    expect(second.hub.registry.byName('follower')).toBeFalsy();

    // The hub goes away the way a switch leaves it: stopped, with the other candidate already up.
    await first.hub.stop();

    await waitFor('the daemon to register with the second hub', () => !!second.hub.registry.byName('follower'));
    expect(second.hub.registry.byName('follower')?.status).toBe('online');

    // and it keeps beating there rather than treating the move as a one-off
    const seenAt = second.hub.registry.byName('follower')!.lastHeartbeat;
    await waitFor('a further heartbeat on the second hub', () => second.hub.registry.byName('follower')!.lastHeartbeat > seenAt);
  }, 30_000);
});
