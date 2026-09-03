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
    expect(result.stderrTail).toContain('timeout');
  }, 5000);
});
