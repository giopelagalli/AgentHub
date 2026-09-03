import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { JobType } from '@agenthub/shared';

export interface DaemonConfigOptions {
  name: string;
  hubUrl: string;
  jobTypes: JobType[];
  workspaceRoot: string;
  claimIntervalMs?: number;
  heartbeatMs?: number;
}

export interface DaemonConfigResult {
  path: string;
  servePort: number;
}

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');

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

// Writes a temp daemon YAML config with one mock serving entry on an ephemeral port. Returns the
// config path and the port the mock will listen on (so callers can clean up that process later).
export async function writeDaemonConfig(opts: DaemonConfigOptions): Promise<DaemonConfigResult> {
  const servePort = await getEphemeralPort();
  const dir = mkdtempSync(join(tmpdir(), 'ah-daemon-'));
  const path = join(dir, 'daemon.yaml');
  writeFileSync(path, [
    'node:',
    `  name: ${opts.name}`,
    '  arch: arm64',
    `hub: ${opts.hubUrl}`,
    `heartbeatMs: ${opts.heartbeatMs ?? 200}`,
    `claimIntervalMs: ${opts.claimIntervalMs ?? 200}`,
    `workspaceRoot: ${opts.workspaceRoot}`,
    `jobTypes: [${opts.jobTypes.join(', ')}]`,
    'serving:',
    '  - tier: worker',
    '    model: mock-model',
    `    port: ${servePort}`,
    '    maxStreams: 4',
    `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
  ].join('\n'));
  return { path, servePort };
}
