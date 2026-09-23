import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, TurnEvent } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb, type Db } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { workspaceTools, type Tool, type ToolContext } from '../src/agents/tools.js';
import { BRIEFING_RESERVE, ORCHESTRATOR_TOOL_CALLS } from '../src/agents/budgets.js';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-loop-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
  await writeFile(join(bundle.workspace, 'notes.txt'), 'the file body', 'utf8');
  mocks = [];
});

afterEach(async () => {
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  loop: AgentLoop;
  transcript: Transcript;
  mock: MockOpenAI;
  db: Db;
  ctx: Omit<ToolContext, 'sessionId' | 'log'>;
}

async function setup(script: ScriptStep[], opts: { serveWorker?: boolean } = {}): Promise<Harness> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [{ tier: opts.serveWorker === false ? 'vision' : 'worker', url, model: 'mock-model', maxStreams: 2 }],
  });
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });
  return { loop, transcript, mock, db, ctx: { bundle, hub: { queue: new JobQueue(db), nodes: registry } } };
}

const readNotes: ScriptStep = { toolCalls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }] };

const runOpts = (over: Partial<Parameters<AgentLoop['run']>[0]> = {}) => ({
  kind: 'subagent' as const,
  subject: 'demo',
  tier: 'worker' as const,
  system: 'you are a worker',
  user: 'summarize notes.txt',
  tools: workspaceTools(),
  maxToolCalls: 25,
  ...over,
});

describe('AgentLoop', () => {
  it('runs a tool call and returns the model reply that follows it', async () => {
    const { loop, mock, ctx } = await setup([readNotes, { content: 'summary' }]);

    const res = await loop.run({ ...runOpts(), ctx });

    expect(res).toMatchObject({ text: 'summary', toolCalls: 1, outcome: 'stop' });

    const sent = mock.lastRequest().messages as { role: string; content: string }[];
    const toolMsg = sent.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('the file body');
    expect(mock.lastRequest().tools).toHaveLength(workspaceTools().length);
  });

  it('omits tools from the request when the tool list is empty', async () => {
    const { loop, mock, ctx } = await setup([{ content: 'plain reply' }]);

    const res = await loop.run({ ...runOpts({ tools: [] }), ctx });

    expect(res.text).toBe('plain reply');
    expect(mock.lastRequest().tools).toBeUndefined();
  });

  it('ends with budget-exhausted when the tool budget runs out, leaving a replayable transcript', async () => {
    const { loop, transcript, ctx } = await setup([readNotes, readNotes]);

    const res = await loop.run({ ...runOpts({ maxToolCalls: 1 }), ctx });

    expect(res.outcome).toBe('budget-exhausted');
    expect(res.toolCalls).toBe(1);
    expect(transcript.sessions()[0].outcome).toBe('budget-exhausted');

    // Every tool_call the model issued must have a matching tool result, including the dropped one.
    const messages = transcript.messages(res.sessionId);
    const requested = messages.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : []));
    const answered = messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
    expect(requested).toHaveLength(2);
    expect(answered).toEqual(requested.map((c) => c.id));
    expect(messages.some((m) => m.role === 'tool' && m.content === 'error: tool budget exhausted')).toBe(true);
    expect(messages.some((m) => m.role === 'system' && m.content.includes('budget'))).toBe(false);
    expect(transcript.events(res.sessionId)[0].content).toContain('budget-exhausted');
  });

  it('warns an orchestrator run once, with room to spare, as its tool-call budget runs low', async () => {
    // 37 single-tool-call turns, so there are trailing requests after the warning to check it isn't
    // repeated on, plus a final content-only reply so the run ends cleanly (well under the 40 budget).
    const script: ScriptStep[] = [...Array.from({ length: 37 }, () => readNotes), { content: 'wrapping up' }];
    const { loop, mock, ctx } = await setup(script);

    const res = await loop.run({ ...runOpts({ kind: 'orchestrator', maxToolCalls: ORCHESTRATOR_TOOL_CALLS }), ctx });

    expect(res).toMatchObject({ outcome: 'stop', toolCalls: 37, text: 'wrapping up' });
    expect(mock.requests).toHaveLength(38); // one request per tool call, plus the final content-only reply

    const warningText = `You have ${BRIEFING_RESERVE} tool calls left in this turn. Stop starting new work: finish what is in flight, then call publish_briefing now.`;
    type Sent = { role: string; content: string | null };

    // It lands as the last message on the request sent right after the 35th tool result (5 left)...
    const afterCall35 = mock.requests[35].messages as Sent[];
    expect(afterCall35.at(-1)).toEqual({ role: 'user', content: warningText });
    // ...stays in every later request's history too...
    expect(mock.requests.slice(35).every((r) => (r.messages as Sent[]).some((m) => m.content === warningText))).toBe(true);
    // ...but was only ever inserted once: the fullest request carries exactly one copy of it.
    const final = mock.requests.at(-1)!.messages as Sent[];
    expect(final.filter((m) => m.content === warningText)).toHaveLength(1);
  });

  it('never warns a non-orchestrator run, however low its tool-call budget gets', async () => {
    const script: ScriptStep[] = [...Array.from({ length: 5 }, () => readNotes), { content: 'done' }];
    const { loop, mock, ctx } = await setup(script);

    const res = await loop.run({ ...runOpts({ maxToolCalls: 5 }), ctx });

    expect(res).toMatchObject({ outcome: 'stop', toolCalls: 5 });
    expect(mock.requests.some((r) => (r.messages as { content: string | null }[]).some((m) => m.content?.includes('tool calls left in this turn')))).toBe(false);
  });

  it('turns a throwing tool into an error result and keeps going', async () => {
    const boom: Tool = {
      def: { type: 'tool', name: 'boom', description: 'always fails', parameters: { type: 'object', properties: {} } },
      run: async () => { throw new Error('kaboom'); },
    };
    const { loop, transcript, ctx } = await setup([
      { toolCalls: [{ name: 'boom', arguments: {} }] },
      { content: 'recovered' },
    ]);

    const res = await loop.run({ ...runOpts({ tools: [boom] }), ctx });

    expect(res).toMatchObject({ text: 'recovered', toolCalls: 1, outcome: 'stop' });
    const toolMsg = transcript.messages(res.sessionId).find((m) => m.role === 'tool');
    expect(toolMsg && 'content' in toolMsg ? toolMsg.content : '').toBe('error: kaboom');
  });

  it('persists the session and every message in order', async () => {
    const { loop, transcript, db, ctx } = await setup([readNotes, { content: 'summary' }]);

    const res = await loop.run({ ...runOpts(), ctx });

    const sessions = transcript.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: res.sessionId, kind: 'subagent', subject: 'demo', tier: 'worker', outcome: 'stop' });
    expect(sessions[0].endedAt).toBeGreaterThanOrEqual(sessions[0].startedAt);

    const messages = transcript.messages(res.sessionId);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    const assistant = messages[2];
    expect(assistant.role === 'assistant' && assistant.tool_calls?.[0].name).toBe('read_file');
    const tool = messages[3];
    expect(tool.role === 'tool' && tool.tool_call_id).toBe('call_0');

    const rows = db.prepare(`SELECT role, tool_call_json FROM messages WHERE session_id=? ORDER BY id`)
      .all(res.sessionId) as { role: string; tool_call_json: string | null }[];
    expect(rows[2].tool_call_json).toContain('read_file');
    expect(rows[0].tool_call_json).toBeNull();
  });

  it('replays given history to the model without re-persisting it into this session', async () => {
    const { loop, transcript, mock, ctx } = await setup([{ content: 'reply' }]);
    const history: ChatMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];

    const res = await loop.run({ ...runOpts({ history }), ctx });

    expect(res.text).toBe('reply');
    const sent = mock.lastRequest().messages as { role: string; content: string | null }[];
    expect(sent.map((m) => `${m.role}: ${m.content}`)).toEqual([
      expect.stringContaining('system:'),
      'user: earlier question',
      'assistant: earlier answer',
      'user: summarize notes.txt',
    ]);
    // This session's own transcript holds only its own turns — the replayed history already lives
    // under whatever session it came from.
    const persisted = transcript.messages(res.sessionId);
    expect(persisted.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(persisted.some((m) => m.content === 'earlier question')).toBe(false);
  });

  it('reports an aborted run', async () => {
    const { loop, transcript, ctx } = await setup([{ content: 'never' }]);
    const controller = new AbortController();
    controller.abort();

    const res = await loop.run({ ...runOpts({ signal: controller.signal }), ctx });

    expect(res.outcome).toBe('aborted');
    expect(transcript.sessions()[0].outcome).toBe('aborted');
  });

  it('aborts mid tool call, killing the running command', async () => {
    const { loop, transcript, ctx } = await setup([
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'echo $$ > pid.txt; sleep 30'] } }] },
    ]);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);

    const res = await loop.run({ ...runOpts({ signal: controller.signal }), ctx });

    expect(res.outcome).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(6000);
    expect(transcript.sessions()[0].outcome).toBe('aborted');

    const pgid = Number((await readFile(join(bundle.workspace, 'pid.txt'), 'utf8')).trim());
    const deadline = Date.now() + 3000;
    for (;;) {
      try { process.kill(-pgid, 0); } catch { break; }
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('replaces an outward tool result that skipped the confirmation gate', async () => {
    // An `outward` tool is only ever allowed to propose; this one acts and reports success, the
    // exact mistake the loop has to catch on the tool's behalf.
    const rogue: Tool = {
      def: { type: 'tool', name: 'post_it', description: 'posts', parameters: { type: 'object', properties: {}, required: [] } },
      outward: true,
      run: async () => 'posted it to the world',
    };
    const { loop, transcript, ctx } = await setup([
      { toolCalls: [{ name: 'post_it', arguments: {} }] },
      { content: 'ok' },
    ]);

    const res = await loop.run({ ...runOpts({ tools: [rogue] }), ctx });

    const toolResults = transcript.messages(res.sessionId).filter((m) => m.role === 'tool');
    expect(toolResults.map((m) => m.content)).toEqual(['error: outward tool did not route through the confirmation gate']);
    expect(transcript.events(res.sessionId)[0].content).toContain('outward-tool-bypass: post_it');
  });

  it('passes an outward tool result through untouched when it is a gate proposal', async () => {
    const proposing: Tool = {
      def: { type: 'tool', name: 'post_it', description: 'posts', parameters: { type: 'object', properties: {}, required: [] } },
      outward: true,
      run: async () => 'pending confirmation act_1',
    };
    const { loop, transcript, ctx } = await setup([
      { toolCalls: [{ name: 'post_it', arguments: {} }] },
      { content: 'ok' },
    ]);

    const res = await loop.run({ ...runOpts({ tools: [proposing] }), ctx });

    const toolResults = transcript.messages(res.sessionId).filter((m) => m.role === 'tool');
    expect(toolResults.map((m) => m.content)).toEqual(['pending confirmation act_1']);
    expect(transcript.events(res.sessionId)).toEqual([]);
  });

  it('reports a gateway failure as an event, not a replayable message', async () => {
    const { loop, transcript, ctx } = await setup([{ content: 'never' }], { serveWorker: false });

    const res = await loop.run({ ...runOpts(), ctx });

    expect(res.outcome).toBe('error');
    expect(transcript.sessions()[0].outcome).toBe('error');
    expect(transcript.messages(res.sessionId).map((m) => m.role)).toEqual(['system', 'user']);
    expect(transcript.events(res.sessionId)).toHaveLength(1);
    expect(transcript.events(res.sessionId)[0].content).toContain('gateway error');
  });

  it('calls onBusy(true) then onBusy(false) around a run tagged with a member id', async () => {
    const { loop, ctx } = await setup([{ content: 'done' }]);
    const calls: boolean[] = [];

    const res = await loop.run({ ...runOpts({ memberId: 'coder-1', onBusy: (busy) => calls.push(busy) }), ctx });

    expect(res.outcome).toBe('stop');
    expect(calls).toEqual([true, false]);
  });

  it('never calls onBusy for a run with no member id', async () => {
    const { loop, ctx } = await setup([{ content: 'done' }]);
    const calls: boolean[] = [];

    await loop.run({ ...runOpts({ onBusy: (busy) => calls.push(busy) }), ctx });

    expect(calls).toEqual([]);
  });

  it('still calls onBusy(false) when a member-tagged run ends abnormally', async () => {
    const { loop, ctx } = await setup([], { serveWorker: false });
    const calls: boolean[] = [];

    const res = await loop.run({ ...runOpts({ memberId: 'coder-1', onBusy: (busy) => calls.push(busy) }), ctx });

    expect(res.outcome).toBe('error');
    expect(calls).toEqual([true, false]);
  });

  it('emits a text event for a text-only run, as the run kind when there is no member', async () => {
    const { loop, transcript, ctx } = await setup([{ content: 'plain reply' }]);
    const events: TurnEvent[] = [];
    let started: number | undefined;

    const res = await loop.run({ ...runOpts({ tools: [], onEvent: (e) => events.push(e), onStart: (id) => { started = id; } }), ctx });

    expect(started).toBe(res.sessionId);
    // What the model turn said, then what it cost — a local endpoint bills nothing.
    expect(events).toEqual([
      { kind: 'text', who: 'subagent', text: 'plain reply' },
      { kind: 'usage', who: 'subagent', usd: 0, tokens: expect.any(Number) },
    ]);
    expect(transcript.turnEvents(res.sessionId)).toEqual(events.map((e) => ({ ...e, at: expect.any(Number) })));
    // The turn events are not mixed into the session's own notes.
    expect(transcript.events(res.sessionId)).toEqual([]);
  });

  it('emits tool-call / tool-result around every step, attributed to the member, and persists them', async () => {
    const boom: Tool = {
      def: { type: 'tool', name: 'boom', description: 'always fails', parameters: { type: 'object', properties: {} } },
      run: async () => { throw new Error('kaboom'); },
    };
    const { loop, transcript, ctx } = await setup([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }, { name: 'boom', arguments: {} }], content: 'reading' },
      { content: 'summary' },
    ]);
    const events: TurnEvent[] = [];

    const res = await loop.run({ ...runOpts({ tools: [...workspaceTools(), boom], memberId: 'coder-1', onEvent: (e) => events.push(e) }), ctx });

    expect(events.map((e) => e.kind)).toEqual(['text', 'usage', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'text', 'usage']);
    expect(events.every((e) => 'who' in e && e.who === 'coder-1')).toBe(true);
    expect(events[2]).toEqual({ kind: 'tool-call', who: 'coder-1', tool: 'read_file', args: '{"path":"notes.txt"}' });
    expect(events[3]).toMatchObject({ kind: 'tool-result', tool: 'read_file', ok: true, summary: 'the file body', ms: expect.any(Number) });
    expect(events[5]).toMatchObject({ kind: 'tool-result', tool: 'boom', ok: false, summary: 'error: kaboom' });
    expect(transcript.turnEvents(res.sessionId).map((e) => e.kind)).toEqual(events.map((e) => e.kind));
  });

  it('clips long text and argument summaries', async () => {
    const long = 'x'.repeat(1000);
    const { loop, ctx } = await setup([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'big.txt', content: long } }], content: long },
      { content: 'done' },
    ]);
    const events: TurnEvent[] = [];

    await loop.run({ ...runOpts({ onEvent: (e) => events.push(e) }), ctx });

    const text = events[0];
    const call = events[2]; // [1] is the turn's usage event
    expect(text.kind === 'text' && text.text.length).toBe(300);
    expect(call.kind === 'tool-call' && call.args.length).toBe(200);
  });
});
