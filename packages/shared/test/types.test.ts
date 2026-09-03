import { describe, it, expect } from 'vitest';
import { PRIORITY_RANK, comparePriority } from '../src/index.js';
import type { Job, JobLogLine, JobResult, JobSpec, NodeInfo, NodeRegistration, ShellTaskPayload } from '../src/index.js';

describe('shared types', () => {
  it('ranks priorities interactive < project < batch', () => {
    expect(PRIORITY_RANK.interactive).toBeLessThan(PRIORITY_RANK.project);
    expect(PRIORITY_RANK.project).toBeLessThan(PRIORITY_RANK.batch);
  });

  it('comparePriority sorts specs by rank ascending', () => {
    const a: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'batch', payload: {} };
    const b: JobSpec = { type: 'llm-session', tier: 'worker', priority: 'interactive', payload: {} };
    expect([a, b].sort(comparePriority)[0]).toBe(b);
  });

  it('Job carries attempts/result/error alongside a JobResult and a ShellTaskPayload', () => {
    const payload: ShellTaskPayload = { cmd: ['echo', 'hi'], cwd: '.', timeoutMs: 1000, env: { A: '1' } };
    const result: JobResult = { exitCode: 0, stdoutTail: 'hi\n', stderrTail: '', data: null };
    const job: Job = {
      id: 1, type: 'shell-task', tier: 'worker', priority: 'batch', payload,
      status: 'done', nodeId: 3, createdAt: 0, updatedAt: 1,
      attempts: 1, result, error: null,
    };
    expect(job.attempts).toBe(1);
    expect(job.result?.exitCode).toBe(0);
    expect(job.error).toBeNull();
  });

  it('NodeRegistration.jobTypes is optional; NodeInfo.jobTypes is always present', () => {
    const reg: NodeRegistration = { name: 'spark', arch: 'arm64', endpoints: [] };
    const regWithTypes: NodeRegistration = { ...reg, jobTypes: ['shell-task'] };
    const info: NodeInfo = {
      ...regWithTypes, jobTypes: ['shell-task'], id: 1, status: 'online', lastHeartbeat: 0,
    };
    expect(reg.jobTypes).toBeUndefined();
    expect(info.jobTypes).toEqual(['shell-task']);
  });

  it('JobLogLine shape', () => {
    const line: JobLogLine = { jobId: 1, seq: 0, line: 'hello', at: 0 };
    expect(line.line).toBe('hello');
  });
});
