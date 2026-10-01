import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { TeamMember, TurnEvent } from '@agenthub/shared';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { AgentLoop, type LoopUsage } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { UsageStore } from '../src/usage.js';
import { claudeCodeHarness, SUBSCRIPTION_PROVIDER } from '../src/agents/harness/claude-code.js';
import { claudeCodeStatus, harnessStatus } from '../src/agents/harness/detect.js';
import { selectHarness } from '../src/agents/harness/select.js';
import type { HarnessTask } from '../src/agents/harness/index.js';
import type { SandboxOptions, SandboxStatus } from '../src/agents/harness/sandbox.js';
import { FAKE_CLAUDE } from './fake-claude.js';

/** The OS sandbox, stood in for as in harness.test.ts: it records what it was asked to wrap and runs it as is. */
const sandbox = vi.hoisted(() => ({
  status: { available: true } as SandboxStatus,
  asked: [] as unknown[],
  wrapped: [] as SandboxOptions[],
}));
vi.mock('../src/agents/harness/sandbox.js', async (original) => ({
  ...(await original<typeof import('../src/agents/harness/sandbox.js')>()),
  sandboxStatus: async (query: unknown) => { sandbox.asked.push(query); return sandbox.status; },
  sandboxedCommand: (_platform: NodeJS.Platform, o: SandboxOptions) => {
    sandbox.wrapped.push(o);
    return { cmd: o.argv[0], args: o.argv.slice(1) };
  },
}));

interface Invocation { argv: string[]; cwd: string; env: Record<string, string | null> }

let root: string;
let workspace: string;
let bundle: ProjectBundle;
let logPath: string;
let transcript: Transcript;
let usageStore: UsageStore;
let loop: AgentLoop;
let ledger: LoopUsage[];
const saved = { PATH: process.env.PATH, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-claude-code-')));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  workspace = bundle.workspace;
  const binDir = join(root, 'bin');
  logPath = join(root, 'claude-invocation.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'claude'), FAKE_CLAUDE, 'utf8');
  await chmod(join(binDir, 'claude'), 0o755);
  // First on PATH, so the fake shadows any real, signed-in claude on the host running the suite.
  process.env.PATH = `${binDir}${delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_CLAUDE_LOG = logPath;
  process.env.FAKE_CLAUDE_MODE = 'report';
  process.env.FAKE_CLAUDE_AUTH = 'subscription';
  // A key in the hub's environment must never reach the CLI: it would turn the run into API billing.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-hub-key';
  sandbox.status = { available: true };
  sandbox.asked = [];
  sandbox.wrapped = [];

  const db = openDb(':memory:');
  transcript = new Transcript(db);
  usageStore = new UsageStore(db);
  ledger = [];
  loop = new AgentLoop({
    gateway: new ModelGateway(new NodeRegistry(db)), transcript,
    onUsage: (u) => { ledger.push(u); usageStore.record({ ...u.usage, subject: u.subject, sessionId: u.sessionId, kind: u.kind }); },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  process.env.PATH = saved.PATH;
  if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
  for (const k of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_AUTH']) delete process.env[k];
});

const member: TeamMember = { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', harness: 'claude-code', createdAt: 1 };

function harness() {
  return claudeCodeHarness({ bin: 'claude', transcript, onUsage: (u) => loop.recordUsage(u) });
}

async function run(over: Partial<HarnessTask> = {}) {
  const events: TurnEvent[] = [];
  const logs: string[] = [];
  const res = await harness().run({
    workspace, task: 'Fix boot()', role: 'coder', member, instructions: 'Prefer small diffs.', tools: 'workspace',
    budget: { toolCalls: 30, wallClockMs: 20_000 }, ...over,
  }, { who: 'coder-1', subject: 'demo', log: (l) => logs.push(l), onEvent: (e) => events.push(e) });
  return { res, events, logs };
}

const invocation = async (): Promise<Invocation> => JSON.parse(await readFile(logPath, 'utf8')) as Invocation;
const sessionEvents = (): string =>
  transcript.events(transcript.sessions({ kind: 'subagent' })[0].id).map((e) => e.content).join('\n');

describe('the claude-code harness', () => {
  it("maps claude's stream-json onto the turn feed and reports what it wrote", async () => {
    process.env.FAKE_CLAUDE_MODE = 'write';
    const { res, events } = await run();

    expect(res.outcome).toBe('stop');
    expect(res.report).toBe('Wrote src/app.js and built dist/out.js.');
    // The Write tool's path first; the file `bash` wrote comes from the workspace scan; the refused write is neither.
    expect(res.filesWritten).toEqual(['src/app.js', 'dist/out.js']);
    expect(res.toolCalls).toBe(3);
    expect(res.lastTool).toBe('Write');
    expect(events).toContainEqual({ kind: 'tool-call', who: 'coder-1', tool: 'Write', args: expect.stringContaining('src/app.js') });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-result', tool: 'Bash', ok: true, summary: 'built' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-result', tool: 'Write', ok: false }));
    expect(events).toContainEqual({ kind: 'text', who: 'coder-1', text: 'Wrote src/app.js.' });

    const session = transcript.sessions({ kind: 'subagent' })[0];
    expect(session.outcome).toBe('stop');
    expect(transcript.messages(session.id).at(-1)).toMatchObject({ role: 'assistant', content: 'Wrote src/app.js and built dist/out.js.' });
  });

  it('files the usage under the subscription with no dollars, so it never counts toward the cloud cap', async () => {
    const { events } = await run();

    // From the result's modelUsage: prompt = fresh + cache reads + cache writes.
    expect(ledger).toEqual([{
      sessionId: transcript.sessions({ kind: 'subagent' })[0].id, kind: 'subagent', subject: 'demo', memberId: 'coder-1',
      usage: {
        promptTokens: 3330, cachedTokens: 3000, completionTokens: 60,
        usd: null, provider: SUBSCRIPTION_PROVIDER, model: 'claude-fake-1', node: 'claude-code',
      },
    }]);
    expect(events).toContainEqual({ kind: 'usage', who: 'coder-1', usd: null, tokens: 3390 });
    expect(usageStore.cloudUsdSince(0)).toBe(0);
    expect(usageStore.summary({ since: 0 }).tokens).toEqual({ prompt: 3330, cached: 3000, completion: 60 });
  });

  it('runs claude headless in the workspace, never prompting, on the subscription and not a hub key', async () => {
    await run();
    const { argv, cwd, env } = await invocation();

    expect(cwd).toBe(workspace);
    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Bash,Grep,Glob');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Edit,Write,Bash,Grep,Glob');
    expect(argv).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
    // The task is last, after `--`, so neither a variadic option nor a leading dash can swallow it.
    expect(argv.slice(-2)).toEqual(['--', 'Fix boot()']);
    const system = argv[argv.indexOf('--append-system-prompt') + 1];
    expect(system).toContain('You are a coder');
    expect(system).toContain('Prefer small diffs.');

    expect(env.ANTHROPIC_API_KEY).toBeNull();
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.CLAUDE_CODE_TMPDIR).toBe(env.TMPDIR);
    expect(sandbox.wrapped).toEqual([expect.objectContaining({ https: true, keychain: true, writableWorkspace: true })]);
    expect(sandbox.wrapped[0]).not.toHaveProperty('door');
  });

  it('offers only the read-only tools, in a read-only workspace, for the read-only policy', async () => {
    await run({ tools: 'read-only' });
    const { argv } = await invocation();
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob');
    expect(sandbox.wrapped).toEqual([expect.objectContaining({ writableWorkspace: false })]);
  });

  it('stops the run at the first tool call past the budget, and still files what it used', async () => {
    process.env.FAKE_CLAUDE_MODE = 'many';
    const { res } = await run({ budget: { toolCalls: 5, wallClockMs: 20_000 } });

    expect(res.outcome).toBe('budget-exhausted');
    expect(res.toolCalls).toBeGreaterThanOrEqual(6);
    expect(sessionEvents()).toContain('tool call budget of 5');
    // No result event arrived, so the usage is summed from the messages, one per message id.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].usage).toMatchObject({ usd: null, provider: SUBSCRIPTION_PROVIDER, cachedTokens: expect.any(Number) });
    expect(ledger[0].usage.promptTokens % 1110).toBe(0);
  });

  it('kills the whole process group when the turn is aborted', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const controller = new AbortController();
    const running = run({ signal: controller.signal });
    const pidFile = `${logPath}.pid`;
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    controller.abort();

    const { res } = await running;
    expect(res.outcome).toBe('aborted');
    expect(transcript.sessions({ kind: 'subagent' })[0].outcome).toBe('aborted');
    const alive = (): boolean => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });

  it("reports a CLI that is not signed in as an error carrying the CLI's own message", async () => {
    process.env.FAKE_CLAUDE_MODE = 'signed-out';
    const { res } = await run();
    expect(res.outcome).toBe('error');
    expect(res.report).toBe('the claude-code harness failed: Not logged in · Please run /login');
    expect(sessionEvents()).toContain('Not logged in');
  });
});

describe('claude-code detection and selection', () => {
  const select = (over: { member?: TeamMember; pinnedTools?: boolean } = {}) => selectHarness({
    loop, bundle, member: over.member ?? member, extras: [], pinnedTools: over.pinnedTools ?? false,
    tools: () => [], log: () => {},
  });

  it('is available when the CLI is signed in to a subscription and the host can sandbox it with HTTPS', async () => {
    expect(await claudeCodeStatus()).toEqual({ available: true, bin: 'claude', version: '2.1.0-fake (Claude Code)' });
    expect(sandbox.asked).toEqual([{ https: true }]);
    expect(await harnessStatus()).toContainEqual({ kind: 'claude-code', available: true, version: '2.1.0-fake (Claude Code)' });
    expect((await select()).harness.kind).toBe('claude-code');
  });

  it('is unavailable when the binary is missing, and the task runs on the built-in loop', async () => {
    await mkdir(join(root, 'empty'), { recursive: true });
    process.env.PATH = join(root, 'empty');
    expect(await claudeCodeStatus()).toEqual({ available: false, reason: 'claude is not installed on this host' });
    expect((await select()).harness.kind).toBe('builtin');
  });

  it('is unavailable, saying how to fix it, when the CLI is signed out or signed in with an API key', async () => {
    process.env.FAKE_CLAUDE_AUTH = 'signed-out';
    expect(await claudeCodeStatus()).toMatchObject({ available: false, reason: expect.stringContaining('run `claude` once') });
    process.env.FAKE_CLAUDE_AUTH = 'api-key';
    expect(await claudeCodeStatus()).toMatchObject({ available: false, reason: expect.stringContaining('not a Claude subscription') });
    expect((await select()).harness.kind).toBe('builtin');
  });

  it('checks the login with the stripped environment, so a hub key cannot pass for a subscription', async () => {
    // The fake reports an API-key login whenever ANTHROPIC_API_KEY reaches it; beforeEach set one.
    expect(await claudeCodeStatus()).toMatchObject({ available: true });
  });

  it('is available but says the login is unverified when the status cannot be read', async () => {
    process.env.FAKE_CLAUDE_AUTH = 'garbage';
    expect(await claudeCodeStatus()).toMatchObject({ available: true, note: 'login not verified' });
    expect(await harnessStatus()).toContainEqual(expect.objectContaining({ kind: 'claude-code', available: true, reason: 'login not verified' }));
  });

  it('is refused when the host cannot sandbox it', async () => {
    sandbox.status = { available: false, reason: 'bubblewrap is not installed (sudo apt install bubblewrap)' };
    expect(await claudeCodeStatus()).toMatchObject({ available: false, reason: expect.stringContaining('claude-code cannot be sandboxed') });
    expect((await select()).harness.kind).toBe('builtin');
  });

  it('never runs the milestone reviewer', async () => {
    const reviewer = { ...member, id: 'reviewer-1', role: 'reviewer' as const };
    expect((await select({ member: reviewer, pinnedTools: true })).harness.kind).toBe('builtin');
  });
});
