import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectManifest, NodeInfo, TurnRecord } from '@agenthub/shared';
import { startSim } from '../sim/sim.js';

/** This process's live children; `pgrep` exits 1 when there are none. */
function children(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('npm run sim', () => {
  it('boots a seeded hub that logs in with the sim password, runs a turn, and stops clean', async () => {
    const sim = await startSim({ port: 0, previewPort: 0, tokenDelayMs: 0 });
    try {
      expect(sim.seeded).toHaveLength(3);

      const login = await fetch(`${sim.url}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'sim' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const get = async <T>(path: string): Promise<T> => (await fetch(`${sim.url}${path}`, { headers: { cookie } })).json() as Promise<T>;

      const projects = await get<ProjectManifest[]>('/api/projects');
      expect(projects.map((p) => p.slug).sort()).toEqual(['habit-tracker', 'pomodoro-cli', 'scratch']);
      const nodes = await get<NodeInfo[]>('/api/nodes');
      expect(nodes.map((n) => n.name).sort()).toEqual(['sim-pc', 'sim-spark']);

      const before = await get<{ turns: TurnRecord[] }>('/api/projects/pomodoro-cli/turns');
      expect(before.turns).toHaveLength(2);
      const turn = await fetch(`${sim.url}/api/projects/pomodoro-cli/turn`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
      });
      expect(turn.status).toBe(200);

      const after = await get<{ running: unknown; turns: TurnRecord[] }>('/api/projects/pomodoro-cli/turns');
      expect(after.running).toBeNull();
      expect(after.turns).toHaveLength(3);
      const kinds = after.turns[0]!.events.map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['subagent-start', 'verify', 'turn-end']));
      expect(after.turns[0]!.cost.usd).toBeGreaterThan(0);
      const { milestones } = await get<{ milestones: { id: string; status: string }[] }>('/api/projects/pomodoro-cli/roadmap');
      expect(milestones.find((m) => m.id === 'm4')?.status).toBe('done');
    } finally {
      await sim.stop();
    }
    expect(existsSync(sim.dataRoot)).toBe(false);
    await expect(fetch(`${sim.url}/api/health`)).rejects.toThrow();
    expect(children()).toEqual([]);
  }, 30_000);

  it('refuses a data dir with a hub.db it did not create, and will not --reset it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agenthub-real-'));
    try {
      await writeFile(join(dir, 'hub.db'), 'not the sim\'s');
      await expect(startSim({ port: 0, previewPort: 0, dataRoot: dir })).rejects.toThrow(/refusing to use .*hub\.db/);
      await expect(startSim({ port: 0, previewPort: 0, dataRoot: dir, reset: true })).rejects.toThrow(/refusing/);
      expect(await readdir(dir)).toEqual(['hub.db']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
