import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dump, load } from 'js-yaml';
import { CLAUDE_CODE_LOCAL_ONLY_REASON, type HarnessKind, type TeamMember, type TeamRoster, type TurnEvent } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { ApiTokens } from '../src/door.js';
import { ADMIN_USER } from '../src/enrollment.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { SUBAGENT_TOOL_CALLS } from '../src/agents/budgets.js';
import { runSubagent, type Tool, type ToolContext } from '../src/agents/tools.js';
import { harnessStatus, type HarnessDoor } from '../src/agents/harness/index.js';
import { createHub, type Hub } from '../src/server.js';
import type { SandboxOptions, SandboxStatus } from '../src/agents/harness/sandbox.js';
import { FAKE_CLAUDE } from './fake-claude.js';

/**
 * The OS sandbox, stood in for: these tests are about the adapter, and the fake pi writes its log
 * outside the workspace, which the real sandbox (sandbox.test.ts) would rightly refuse. The stand-in
 * records what it was asked to wrap and runs it as is; `status` is what detection reports.
 */
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

/**
 * A stand-in for the pi CLI on PATH. It answers `--version` like the real one and otherwise emits
 * the JSON Lines event stream verified in decision 0049 — `tool_execution_start`/`_end` around
 * each tool call, `message_end` per assistant message — driven by `FAKE_PI_MODE`. It records its
 * argv, cwd and the config pi was pointed at, so a test can assert how the adapter invoked it.
 *
 * CommonJS on purpose: an extensionless executable is what `pi` is on PATH, and node runs one as CJS.
 */
const FAKE_PI = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const argv = process.argv.slice(2);
// On stderr, which is where pi 0.73 actually prints it (decision 0049).
if (argv.includes('--version')) { process.stderr.write('0.73.1-fake\\n'); process.exit(0); }

writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  argv, cwd: process.cwd(),
  models: JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')),
  key: process.env.AGENTHUB_HARNESS_KEY || null,
  githubToken: process.env.GITHUB_TOKEN || null,
}));

const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 };
const say = (text) => emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage } });
const wrote = (id, path) => {
  emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'write', args: { path, content: 'x' } });
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, 'x');
  emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'write', result: { content: [{ type: 'text', text: 'Successfully wrote 1 bytes to ' + path }] }, isError: false });
};

emit({ type: 'session', version: 3, id: 'fake', cwd: process.cwd() });
const mode = process.env.FAKE_PI_MODE;
if (mode === 'write') {
  wrote('c1', 'src/app.js');
  wrote('c2', 'src/app.js');
  emit({ type: 'tool_execution_start', toolCallId: 'c3', toolName: 'bash', args: { command: 'npm test' } });
  emit({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  say('Wrote src/app.js and ran the tests.');
} else if (mode === 'escape') {
  wrote('c1', '../escaped.txt');
  say('Done.');
} else if (mode === 'fail') {
  process.stderr.write('pi: no such model\\n');
  process.exit(3);
} else if (mode === 'many') {
  for (let i = 0; i < 100; i++) wrote('c' + i, 'f' + i + '.txt');
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  appendFileSync(process.env.FAKE_PI_LOG + '.started', 'x');
  setInterval(() => {}, 1000);
} else {
  say('Nothing to change.');
}
`;

interface Invocation {
  argv: string[];
  cwd: string;
  models: { providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: { id: string }[] }> };
  key: string | null;
  githubToken: string | null;
}

let root: string;
let bundle: ProjectBundle;
let binDir: string;
let logPath: string;
let mock: MockOpenAI;
let transcript: Transcript;
let gateway: ModelGateway;
let loop: AgentLoop;
let tokens: ApiTokens;
let door: HarnessDoor;
/** Where the hub's door is said to listen; the fake pi only records it, so nothing has to answer. */
const DOOR_BASE = 'http://127.0.0.1:4555';
const savedPath = process.env.PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-harness-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  binDir = join(root, 'bin');
  logPath = join(root, 'pi-invocation.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'pi'), FAKE_PI, 'utf8');
  await chmod(join(binDir, 'pi'), 0o755);
  // A signed-out claude shadows any real one on the host: these tests must never reach it.
  await writeFile(join(binDir, 'claude'), FAKE_CLAUDE, 'utf8');
  await chmod(join(binDir, 'claude'), 0o755);
  process.env.FAKE_CLAUDE_AUTH = 'signed-out';
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ''}`;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_MODE = 'report';
  sandbox.status = { available: true };
  sandbox.asked = [];
  sandbox.wrapped = [];

  mock = createMockOpenAI();
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
  transcript = new Transcript(db);
  gateway = new ModelGateway(registry);
  loop = new AgentLoop({ gateway, transcript });
  tokens = new ApiTokens(db);
  door = { base: () => DOOR_BASE, tokens };
});

afterEach(async () => {
  await mock.close();
  await rm(root, { recursive: true, force: true });
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  delete process.env.FAKE_PI_LOG;
  delete process.env.FAKE_PI_MODE;
  delete process.env.HARNESS_REVIEWER_PI;
  delete process.env.FAKE_CLAUDE_AUTH;
});

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', harness: 'pi', createdAt: 1, ...over,
});

/** The project default, which the manifest carries and a member's own `harness` overrides. */
async function setProjectHarness(harness: HarnessKind): Promise<void> {
  const path = join(bundle.dir, 'manifest.yaml');
  const manifest = load(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, dump({ ...manifest, harness }), 'utf8');
}

interface Run { events: TurnEvent[]; logs: string[]; ctx: ToolContext }

function context(signal?: AbortSignal): Run {
  const events: TurnEvent[] = [];
  const logs: string[] = [];
  const ctx: ToolContext = {
    bundle, sessionId: 0, log: (l) => logs.push(l), onEvent: (e) => events.push(e),
    ...(signal ? { signal } : {}),
  };
  return { events, logs, ctx };
}

/** The latest subagent session's plain events, joined — what the drawer shows besides the feed. */
const sessionEvents = (): string =>
  transcript.events(transcript.sessions({ kind: 'subagent' })[0].id).map((e) => e.content).join('\n');

const invocation = async (): Promise<Invocation> => JSON.parse(await readFile(logPath, 'utf8')) as Invocation;

describe('the pi harness', () => {
  it("runs the task in the workspace, maps pi's events and reports what it wrote", async () => {
    process.env.FAKE_PI_MODE = 'write';
    const { events, ctx } = context();
    const res = await runSubagent({ loop, subject: 'demo', door }, ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    expect(res.outcome).toBe('stop');
    expect(res.text).toBe('Wrote src/app.js and ran the tests.');
    // Once, in first-written order, and only for the tool call that names a file.
    expect(res.filesWritten).toEqual(['src/app.js']);
    expect(existsSync(join(bundle.workspace, 'src', 'app.js'))).toBe(true);
    // Through the sandbox, confined to the workspace and its own config dir, with only the door reachable.
    expect(sandbox.wrapped).toEqual([expect.objectContaining({
      workspace: await realpath(bundle.workspace), door: { host: '127.0.0.1', port: 4555 }, writableWorkspace: true,
      tmpDir: expect.stringContaining('agenthub-pi-'), argv: expect.arrayContaining(['pi', '-p', '--mode', 'json']),
    })]);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder' }),
      { kind: 'tool-call', who: 'coder-1', tool: 'write', args: expect.stringContaining('src/app.js') },
      expect.objectContaining({ kind: 'tool-result', who: 'coder-1', tool: 'write', ok: true }),
      expect.objectContaining({ kind: 'tool-call', tool: 'write' }),
      expect.objectContaining({ kind: 'tool-result', tool: 'write', ok: true }),
      expect.objectContaining({ kind: 'tool-call', tool: 'bash' }),
      expect.objectContaining({ kind: 'tool-result', tool: 'bash', ok: true }),
      { kind: 'text', who: 'coder-1', text: 'Wrote src/app.js and ran the tests.' },
      // Priced by the door's ledger row, not here: the worker tier names no model to price.
      { kind: 'usage', who: 'coder-1', usd: null, tokens: 150 },
      expect.objectContaining({ kind: 'subagent-end', who: 'coder-1', outcome: 'stop' }),
    ]);
  });

  it('records the run under its own session so the employee drawer can replay it', async () => {
    const { ctx } = context();
    const res = await runSubagent({ loop, subject: 'demo', door }, ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    const session = transcript.sessions({ kind: 'subagent' })[0];
    expect(session).toMatchObject({ memberId: 'coder-1', subject: 'demo', outcome: 'stop' });
    expect(res.sessionId).toBe(session.id);
    expect(transcript.messages(session.id).map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(transcript.lastMessage(session.id)).toBe('Nothing to change.');
    // Every event the caller saw between the brackets is persisted under the run's own session too.
    expect(transcript.turnEvents(session.id).map((e) => e.kind)).toEqual(['text', 'usage']);
  });

  it("points pi at the hub's own door, with a per-run token in its environment and not on disk", async () => {
    await runSubagent({ loop, subject: 'demo', door }, context().ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    const { argv, cwd, models, key, githubToken } = await invocation();
    expect(cwd).toBe(await realpath(bundle.workspace));
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('--mode') + 1]).toBe('json');
    expect(argv[argv.indexOf('--model') + 1]).toBe('agenthub/agenthub/worker');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,edit,write,bash,grep,find,ls');
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('off');
    expect(argv.at(-1)).toBe('Fix boot()');
    const provider = models.providers.agenthub;
    expect(provider.baseUrl).toBe(`${DOOR_BASE}/v1`);
    expect(provider.api).toBe('openai-completions');
    expect(provider.models.map((m) => m.id)).toEqual(['agenthub/worker']);
    // The config names the variable; the token itself only ever exists in pi's environment.
    expect(provider.apiKey).toBe('AGENTHUB_HARNESS_KEY');
    expect(key).toMatch(/^ah_[0-9a-f]{48}$/);
    // Minted for this run and revoked when it ended: the door no longer opens to it.
    expect(tokens.verify(key!)).toBeNull();
    expect(tokens.list(ADMIN_USER)).toEqual([]);
    // And the hub's own credentials are stripped from that environment, as for any agent shell.
    expect(githubToken).toBeNull();
  });

  it("carries the project's route through the door: a local-only project asks for @local", async () => {
    await runSubagent({ loop, subject: 'demo', door, modelPolicy: { prefer: 'local' } }, context().ctx, {
      role: 'coder', member: member(), task: 'Fix boot()',
    });

    const { argv, models } = await invocation();
    expect(argv[argv.indexOf('--model') + 1]).toBe('agenthub/agenthub/worker@local');
    expect(models.providers.agenthub.models.map((m) => m.id)).toEqual(['agenthub/worker@local']);
  });

  it("carries the role and the member's standing instructions into pi's system prompt", async () => {
    await runSubagent({ loop, subject: 'demo', door }, context().ctx, {
      role: 'coder', member: member({ instructions: 'Always run the linter.' }), task: 'Fix boot()',
    });

    const { argv } = await invocation();
    const system = argv[argv.indexOf('--append-system-prompt') + 1];
    expect(system).toContain('You are a coder');
    expect(system).toContain('Always run the linter.');
    // pi brings its own tools, so the built-in loop's tool names must not be described to it.
    expect(system).not.toContain('write_file');
  });

  it('does not report a write that landed outside the workspace', async () => {
    process.env.FAKE_PI_MODE = 'escape';
    const { logs, ctx } = context();
    const res = await runSubagent({ loop, subject: 'demo', door }, ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    expect(res.filesWritten).toEqual([]);
    expect(logs.join('\n')).toContain('pi wrote outside the workspace');
    expect(sessionEvents()).toContain('pi wrote outside the workspace');
  });

  it('stops the run at the tool-call budget pi has no limit of its own for', async () => {
    process.env.FAKE_PI_MODE = 'many';
    const res = await runSubagent({ loop, subject: 'demo', door }, context().ctx, { role: 'coder', member: member(), task: 'Churn' });

    expect(res.outcome).toBe('budget-exhausted');
    expect(res.toolCalls).toBeGreaterThanOrEqual(SUBAGENT_TOOL_CALLS);
    const session = transcript.sessions({ kind: 'subagent' })[0];
    expect(transcript.events(session.id).map((e) => e.content).join('\n')).toContain(`tool call budget of ${SUBAGENT_TOOL_CALLS}`);
  });

  it('kills the process group when the turn is aborted', async () => {
    process.env.FAKE_PI_MODE = 'hang';
    const controller = new AbortController();
    const running = runSubagent({ loop, subject: 'demo', door }, context(controller.signal).ctx, {
      role: 'coder', member: member(), task: 'Wait',
    });
    // Abort once pi is actually up, so the kill has a live process group to land on.
    for (let i = 0; i < 200 && !existsSync(`${logPath}.started`); i++) await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const res = await running;
    expect(res.outcome).toBe('aborted');
    expect(transcript.sessions({ kind: 'subagent' })[0].outcome).toBe('aborted');
  });

  it('reports a pi that fails to run as an error rather than a silent empty report', async () => {
    process.env.FAKE_PI_MODE = 'fail';
    const { logs, ctx } = context();
    const res = await runSubagent({ loop, subject: 'demo', door }, ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    expect(res.outcome).toBe('error');
    expect(res.text).toContain('the pi harness ended without a report');
    expect(logs.join('\n')).toContain('pi: no such model');
    // `ctx.log` is a no-op in production; the session's events are where pi's stderr survives.
    expect(sessionEvents()).toContain('pi: no such model');
  });

  it('ends the session as an error when setting the run up fails', async () => {
    const broken = { base: () => DOOR_BASE, tokens: { mint: () => { throw new Error('database is locked'); } } as unknown as ApiTokens };
    const res = await runSubagent({ loop, subject: 'demo', door: broken }, context().ctx, { role: 'coder', member: member(), task: 'Fix boot()' });

    expect(res.outcome).toBe('error');
    expect(res.text).toContain('database is locked');
    expect(existsSync(logPath)).toBe(false);
    expect(transcript.sessions({ kind: 'subagent' })[0].outcome).toBe('error');
  });
});

describe('choosing a harness', () => {
  const runFor = async (m: TeamMember, extra: { role?: 'coder' | 'reviewer'; tools?: Tool[] } = {}): Promise<Run> => {
    const run = context();
    await runSubagent({ loop, subject: 'demo', door }, run.ctx, { role: 'coder', task: 'Fix boot()', member: m, ...extra });
    return run;
  };

  it('runs on the built-in loop when neither the member nor the project asks for anything', async () => {
    await runFor(member({ harness: undefined }));
    expect(existsSync(logPath)).toBe(false);
    expect(mock.requests.length).toBeGreaterThan(0);
  });

  it('runs on pi when the project sets it as the default', async () => {
    await setProjectHarness('pi');
    await runFor(member({ harness: undefined }));
    expect(existsSync(logPath)).toBe(true);
    expect(mock.requests.length).toBe(0);
  });

  it('lets a member override the project default back to the built-in loop', async () => {
    await setProjectHarness('pi');
    await runFor(member({ harness: 'builtin' }));
    expect(existsSync(logPath)).toBe(false);
  });

  it('keeps a pinned read-only belt — the milestone reviewer — on the built-in loop', async () => {
    await runFor(member({ id: 'reviewer-1', role: 'reviewer', harness: 'pi' }), { role: 'reviewer', tools: [] });
    expect(existsSync(logPath)).toBe(false);
  });

  it('runs the reviewer on pi, read-only and sandboxed, when HARNESS_REVIEWER_PI=1', async () => {
    process.env.HARNESS_REVIEWER_PI = '1';
    await runFor(member({ id: 'reviewer-1', role: 'reviewer', harness: 'pi' }), { role: 'reviewer', tools: [] });
    const { argv } = await invocation();
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    expect(sandbox.wrapped).toEqual([expect.objectContaining({ writableWorkspace: false })]);
  });

  it('refuses pi, saying why, when this host cannot sandbox it — pi never runs unconfined', async () => {
    sandbox.status = { available: false, reason: 'bubblewrap is not installed (sudo apt install bubblewrap)' };
    const { logs } = await runFor(member());
    expect(existsSync(logPath)).toBe(false);
    expect(sandbox.wrapped).toEqual([]);
    // Asked about this door: a hub bound off loopback (HUB_HOST) is refused here, before pi starts.
    expect(sandbox.asked).toEqual([{ doorBase: DOOR_BASE }]);
    const why = 'pi cannot be sandboxed on this host: bubblewrap is not installed (sudo apt install bubblewrap)';
    expect(logs.join('\n')).toContain(why);
    expect(sessionEvents()).toContain(`${why}; running on the built-in loop`);
  });

  it('falls back to the built-in loop, saying why, when pi is not installed', async () => {
    // An empty PATH rather than one with `binDir` filtered out: the machine running the suite may
    // have a real pi of its own installed, and this test is about the hub host that does not.
    await mkdir(join(root, 'empty'), { recursive: true });
    process.env.PATH = join(root, 'empty');
    const { logs } = await runFor(member());
    expect(existsSync(logPath)).toBe(false);
    expect(logs.join('\n')).toContain('pi is not installed on this host');
    expect(sessionEvents()).toContain('pi is not installed on this host; running on the built-in loop');
  });

  it("refuses pi, saying why, when the hub's door is not available", async () => {
    for (const unavailable of [undefined, { base: () => null, tokens }]) {
      const run = context();
      await runSubagent({ loop, subject: 'demo', ...(unavailable ? { door: unavailable } : {}) }, run.ctx, {
        role: 'coder', task: 'Fix boot()', member: member(),
      });
      expect(existsSync(logPath)).toBe(false);
      expect(run.logs.join('\n')).toContain("the hub's door is not available to pi");
      expect(sessionEvents()).toContain("the hub's door is not available to pi; running on the built-in loop");
    }
  });

  it('runs claude-code on the built-in loop, saying why, when its CLI is not signed in', async () => {
    await setProjectHarness('claude-code');
    await runFor(member({ harness: undefined }));
    expect(existsSync(logPath)).toBe(false);
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(sessionEvents()).toContain('claude is not signed in on this host');
    expect(sessionEvents()).toContain('; running on the built-in loop');
  });

  it('runs on the built-in loop when the manifest names a harness that does not exist', async () => {
    await setProjectHarness('bogus' as HarnessKind);
    await runFor(member({ harness: undefined }));
    expect(existsSync(logPath)).toBe(false);
    expect(mock.requests.length).toBeGreaterThan(0);
  });
});

describe('the harness API', () => {
  let hub: Hub | undefined;
  let hubRoot: string | undefined;

  afterEach(async () => {
    await hub?.stop();
    if (hubRoot) await rm(hubRoot, { recursive: true, force: true });
    hub = undefined; hubRoot = undefined;
  });

  it('does not offer an installed pi on a host that cannot sandbox it, and says why', async () => {
    sandbox.status = { available: false, reason: 'bwrap: setting up uid map: Permission denied' };
    expect(await harnessStatus()).toContainEqual({
      kind: 'pi', available: false, version: '0.73.1-fake',
      reason: 'pi cannot be sandboxed on this host: bwrap: setting up uid map: Permission denied',
    });
  });

  it("offers pi while its CLI is on PATH, and the drawer's choice persists", async () => {
    expect(await harnessStatus()).toEqual([
      { kind: 'builtin', available: true },
      { kind: 'pi', available: true, version: '0.73.1-fake' },
      {
        kind: 'claude-code', available: false, version: '2.1.0-fake (Claude Code)',
        reason: 'claude is not signed in on this host: run `claude` once in a terminal there and log in',
      },
    ]);

    hubRoot = await mkdtemp(join(tmpdir(), 'agenthub-harness-api-'));
    hub = createHub({ projectsRoot: hubRoot });
    await hub.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship it' } });
    const seeded = await hub.app.inject({ method: 'GET', url: '/api/projects/demo/team' });
    const id = (seeded.json() as TeamRoster).members[0].id;

    const listed = await hub.app.inject({ method: 'GET', url: '/api/harnesses' });
    expect(listed.json()).toContainEqual({ kind: 'pi', available: true, version: '0.73.1-fake' });

    const set = await hub.app.inject({ method: 'PATCH', url: `/api/projects/demo/team/${id}`, payload: { harness: 'pi' } });
    expect(set.statusCode).toBe(200);
    expect((set.json() as TeamMember).harness).toBe('pi');
    const roster = await hub.app.inject({ method: 'GET', url: '/api/projects/demo/team' });
    expect((roster.json() as TeamRoster).members[0].harness).toBe('pi');

    const cleared = await hub.app.inject({ method: 'PATCH', url: `/api/projects/demo/team/${id}`, payload: { harness: null } });
    expect((cleared.json() as TeamMember).harness).toBeUndefined();

    // A harness this host cannot run is refused rather than accepted and quietly ignored at turn time.
    const refused = await hub.app.inject({ method: 'PATCH', url: `/api/projects/demo/team/${id}`, payload: { harness: 'claude-code' } });
    expect(refused.statusCode).toBe(400);
  });

  it("sets the project's default harness, and builtin clears it", async () => {
    hubRoot = await mkdtemp(join(tmpdir(), 'agenthub-harness-api-'));
    hub = createHub({ projectsRoot: hubRoot });
    await hub.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship it' } });
    const setProject = (harness: unknown) =>
      hub!.app.inject({ method: 'POST', url: '/api/projects/demo/harness', payload: { harness } });
    const read = async () => ((await hub!.app.inject({ method: 'GET', url: '/api/projects/demo' })).json() as {
      manifest: { harness?: HarnessKind };
    }).manifest.harness;

    const set = await setProject('pi');
    expect(set.statusCode).toBe(200);
    expect(set.json().harness).toBe('pi');
    expect(await read()).toBe('pi');

    // The same refusals as an employee's choice: a kind that does not exist, or one this host cannot run.
    expect((await setProject('bogus')).statusCode).toBe(400);
    const unavailable = await setProject('claude-code');
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error).toBe('claude-code is not installed on this hub');
    expect(await read()).toBe('pi');

    const cleared = await setProject('builtin');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().harness).toBeUndefined();
    expect(await read()).toBeUndefined();

    expect((await hub.app.inject({ method: 'POST', url: '/api/projects/ghost/harness', payload: { harness: 'pi' } })).statusCode).toBe(404);
  });

  it('refuses claude-code for a Local-only project, saying why the run would', async () => {
    hubRoot = await mkdtemp(join(tmpdir(), 'agenthub-harness-api-'));
    hub = createHub({ projectsRoot: hubRoot });
    await hub.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship it' } });
    expect((await hub.app.inject({ method: 'POST', url: '/api/projects/demo/model', payload: { prefer: 'local' } })).statusCode).toBe(200);
    const refused = await hub.app.inject({ method: 'POST', url: '/api/projects/demo/harness', payload: { harness: 'claude-code' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe(CLAUDE_CODE_LOCAL_ONLY_REASON);
  });

  it("refuses claude-code for an employee on a Local-only project, and accepts it on an Auto one", async () => {
    process.env.FAKE_CLAUDE_AUTH = 'subscription';
    hubRoot = await mkdtemp(join(tmpdir(), 'agenthub-harness-api-'));
    hub = createHub({ projectsRoot: hubRoot });
    await hub.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship it' } });
    const id = ((await hub.app.inject({ method: 'GET', url: '/api/projects/demo/team' })).json() as TeamRoster).members[0].id;
    const patch = (harness: unknown) =>
      hub!.app.inject({ method: 'PATCH', url: `/api/projects/demo/team/${id}`, payload: { harness } });
    const accepted = await patch('claude-code');
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as TeamMember).harness).toBe('claude-code');

    expect((await hub.app.inject({ method: 'POST', url: '/api/projects/demo/model', payload: { prefer: 'local' } })).statusCode).toBe(200);
    const refused = await patch('claude-code');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe(CLAUDE_CODE_LOCAL_ONLY_REASON);
    // Other harnesses, and clearing the choice, are unaffected.
    expect((await patch('pi')).statusCode).toBe(200);
    expect((await patch(null)).statusCode).toBe(200);
  });
});
