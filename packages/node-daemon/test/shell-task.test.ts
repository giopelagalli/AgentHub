import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, runShellTask } from '../src/shell-task.js';

const dirs: string[] = [];
function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-ws-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveWorkspace', () => {
  it('resolves to <root>/<project> by default', () => {
    const root = tmpWorkspace();
    expect(resolveWorkspace(root, 'proj', undefined)).toBe(join(root, 'proj'));
  });

  it('resolves to <root>/_default when no project is given', () => {
    const root = tmpWorkspace();
    expect(resolveWorkspace(root, undefined, undefined)).toBe(join(root, '_default'));
  });

  it('throws when cwd escapes the workspace', () => {
    const root = tmpWorkspace();
    expect(() => resolveWorkspace(root, 'proj', '../../etc')).toThrow(/cwd escapes workspace/);
  });
});

describe('runShellTask', () => {
  it('runs a command and reports exit code plus prefixed stdout lines', async () => {
    const root = tmpWorkspace();
    const lines: string[] = [];
    const result = await runShellTask({ cmd: ['echo', 'hello'] }, { workspaceRoot: root, onLine: (l) => lines.push(l) });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain('out: hello');
  });

  it('reports a nonzero exit code', async () => {
    const root = tmpWorkspace();
    const result = await runShellTask(
      { cmd: ['node', '-e', 'process.exit(3)'] },
      { workspaceRoot: root, onLine: () => {} },
    );
    expect(result.exitCode).toBe(3);
  });

  it('rejects when cwd escapes the workspace', async () => {
    const root = tmpWorkspace();
    await expect(
      runShellTask({ cmd: ['echo', 'hi'], cwd: '../../etc' }, { workspaceRoot: root, onLine: () => {} }),
    ).rejects.toThrow(/cwd escapes workspace/);
  });

  it('kills the process on timeout and reports it in the result', async () => {
    const root = tmpWorkspace();
    const result = await runShellTask(
      { cmd: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 },
      { workspaceRoot: root, onLine: () => {} },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.timedOut).toBe(true);
  }, 5000);

  it('kills a backgrounded grandchild on timeout, not just the shell', async () => {
    const root = tmpWorkspace();
    const lines: string[] = [];
    const result = await runShellTask(
      { cmd: ['sh', '-c', 'node -e "setInterval(()=>{},1000)" & echo $!; sleep 100'], timeoutMs: 500 },
      { workspaceRoot: root, onLine: (l) => lines.push(l) },
    );
    expect(result.timedOut).toBe(true);

    const pidLine = lines.find((l) => /^out: \d+$/.test(l));
    expect(pidLine).toBeDefined();
    const grandchildPid = Number(pidLine!.slice('out: '.length));
    await waitForProcessGone(grandchildPid, 5000);
  }, 10000);

  it('eventually kills a grandchild that traps SIGTERM, and stops emitting once resolved', async () => {
    const root = tmpWorkspace();
    const lines: string[] = [];
    const result = await runShellTask(
      {
        cmd: ['sh', '-c', 'node -e "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)" & echo $!; sleep 100'],
        timeoutMs: 500,
      },
      { workspaceRoot: root, onLine: (l) => lines.push(l) },
    );
    expect(result.timedOut).toBe(true);

    const pidLine = lines.find((l) => /^out: \d+$/.test(l));
    expect(pidLine).toBeDefined();
    const grandchildPid = Number(pidLine!.slice('out: '.length));

    // NEW-A: the grandchild ignores SIGTERM and the shell (the direct child we watch) exits well
    // before it does, so only the independent SIGKILL escalation backstop can reap it.
    await waitForProcessGone(grandchildPid, 6000);

    // NEW-B: once runShellTask has resolved, nothing further should arrive via onLine even though
    // the (now-dead, but briefly surviving) grandchild kept the pipes open past resolution.
    const countAtResolve = lines.length;
    await new Promise((r) => setTimeout(r, 1000));
    expect(lines.length).toBe(countAtResolve);
  }, 10000);

  it('does not spawn when the signal is already aborted', async () => {
    const root = tmpWorkspace();
    const controller = new AbortController();
    controller.abort();
    const result = await runShellTask(
      { cmd: ['echo', 'hi'] },
      { workspaceRoot: root, onLine: () => {}, signal: controller.signal },
    );
    expect(result.signal).toBe('aborted');
  });
});

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: the process is gone
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
