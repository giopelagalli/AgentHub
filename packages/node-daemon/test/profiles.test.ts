import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');
const TSX_CLI = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

const dirs: string[] = [];
let hub: Hub | undefined; let daemon: Daemon | undefined;

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-prof-'));
  dirs.push(dir);
  return dir;
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function serving(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/v1/models`)).ok; } catch { return false; }
}

async function waitUntil(check: () => Promise<boolean>, want: boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await check()) === want) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await hub?.stop(); hub = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('daemon serving profiles', () => {
  it('switches profiles over the token-protected control endpoint', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const workerPort = await getEphemeralPort();
    const orchPort = await getEphemeralPort();

    const dir = tmpDir();
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: spark-test', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'hubToken: daemon-tok',
      'heartbeatMs: 1000',
      'controlPort: 0',
      'video:',
      '  comfyUrl: http://127.0.0.1:1',
      'serving:',
      '  - name: worker-vllm',
      '    tier: worker', '    model: mock-model', `    port: ${workerPort}`, '    maxStreams: 4',
      `    cmd: ["node", "${TSX_CLI}", "${MOCK_SERVE}", "${workerPort}"]`,
      '  - name: orchestrator-vllm',
      '    tier: orchestrator', '    model: mock-model', `    port: ${orchPort}`, '    maxStreams: 4',
      `    cmd: ["node", "${TSX_CLI}", "${MOCK_SERVE}", "${orchPort}"]`,
      'profiles:',
      '  llm: [worker-vllm, orchestrator-vllm]',
      '  video: [orchestrator-vllm]',
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();

    // registration advertises the new capabilities (the hub accepted it: the node is online)
    expect(hub.registry.byName('spark-test')?.status).toBe('online');
    const reg = daemon.registration();
    expect(reg.profiles).toEqual(['llm', 'video']);
    expect(reg.video).toBe(true);
    const controlUrl = reg.control!.url;
    expect(controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(await serving(workerPort)).toBe(true);
    expect(await serving(orchPort)).toBe(true);

    // no token → 401, and nothing is switched
    const unauthorized = await fetch(`${controlUrl}/control/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'video' }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await serving(workerPort)).toBe(true);

    // unknown profile → 404
    const unknown = await fetch(`${controlUrl}/control/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer daemon-tok' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(unknown.status).toBe(404);

    // switch to video: the worker entry is stopped, the orchestrator one keeps serving
    const toVideo = await fetch(`${controlUrl}/control/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer daemon-tok' },
      body: JSON.stringify({ name: 'video' }),
    });
    expect(toVideo.status).toBe(200);
    expect(await toVideo.json()).toEqual({ profile: 'video', entries: ['orchestrator-vllm'] });
    expect(await waitUntil(() => serving(workerPort), false)).toBe(true);
    expect(await serving(orchPort)).toBe(true);

    // idempotent: switching to video again changes nothing
    const again = await fetch(`${controlUrl}/control/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer daemon-tok' },
      body: JSON.stringify({ name: 'video' }),
    });
    expect(await again.json()).toEqual({ profile: 'video', entries: ['orchestrator-vllm'] });
    expect(await serving(orchPort)).toBe(true);

    // and back: the worker entry is started again
    const toLlm = await fetch(`${controlUrl}/control/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer daemon-tok' },
      body: JSON.stringify({ name: 'llm' }),
    });
    expect(toLlm.status).toBe(200);
    expect(await serving(workerPort)).toBe(true);
    expect(await serving(orchPort)).toBe(true);
  }, 60000);

  it('rejects a profile naming an unknown serving entry at load time', () => {
    const cfgPath = join(tmpDir(), 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: n', '  arch: arm64',
      'hub: http://127.0.0.1:1',
      'serving:',
      '  - name: a', '    tier: worker', '    model: m', '    port: 9', '    maxStreams: 1', '    cmd: ["true"]',
      'profiles:',
      '  llm: [b]',
    ].join('\n'));
    expect(() => loadConfig(cfgPath)).toThrow(/unknown serving entry b/);
  });
});
