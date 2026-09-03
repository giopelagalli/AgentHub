import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, runShellTask } from '../src/shell-task.js';

describe('resolveWorkspace', () => {
  it('resolves to <root>/<project> by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    expect(resolveWorkspace(root, 'proj', undefined)).toBe(join(root, 'proj'));
  });

  it('resolves to <root>/_default when no project is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    expect(resolveWorkspace(root, undefined, undefined)).toBe(join(root, '_default'));
  });

  it('throws when cwd escapes the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    expect(() => resolveWorkspace(root, 'proj', '../../etc')).toThrow(/cwd escapes workspace/);
  });
});

describe('runShellTask', () => {
  it('runs a command and reports exit code plus prefixed stdout lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    const lines: string[] = [];
    const result = await runShellTask({ cmd: ['echo', 'hello'] }, { workspaceRoot: root, onLine: (l) => lines.push(l) });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain('out: hello');
  });

  it('reports a nonzero exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    const result = await runShellTask(
      { cmd: ['node', '-e', 'process.exit(3)'] },
      { workspaceRoot: root, onLine: () => {} },
    );
    expect(result.exitCode).toBe(3);
  });

  it('rejects when cwd escapes the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    await expect(
      runShellTask({ cmd: ['echo', 'hi'], cwd: '../../etc' }, { workspaceRoot: root, onLine: () => {} }),
    ).rejects.toThrow(/cwd escapes workspace/);
  });

  it('kills the process on timeout and reports it in the result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    const result = await runShellTask(
      { cmd: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 },
      { workspaceRoot: root, onLine: () => {} },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.timedOut).toBe(true);
  }, 5000);

  it('kills a backgrounded grandchild on timeout, not just the shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    const lines: string[] = [];
    const result = await runShellTask(
      { cmd: ['sh', '-c', 'node -e "setInterval(()=>{},1000)" & echo $!; sleep 100'], timeoutMs: 500 },
      { workspaceRoot: root, onLine: (l) => lines.push(l) },
    );
    expect(result.timedOut).toBe(true);

    const pidLine = lines.find((l) => /^out: \d+$/.test(l));
    expect(pidLine).toBeDefined();
    const grandchildPid = Number(pidLine!.slice('out: '.length));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 5000);

  it('eventually kills a grandchild that traps SIGTERM, and stops emitting once resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
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
    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
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
