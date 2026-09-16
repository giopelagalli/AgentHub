import Fastify, { type FastifyInstance } from 'fastify';

export interface ScriptToolCall { name: string; arguments: object; }
export type ScriptStep = { toolCalls: ScriptToolCall[] } | { content: string };

export interface MockOptions {
  tokenDelayMs?: number;
  replyFor?: (lastUser: string) => string;
  script?: ScriptStep[];
  /** Validate requests like a strict OpenAI-compatible provider (see `validationError`). Default true. */
  strict?: boolean;
}

export interface MockOpenAI extends FastifyInstance {
  lastRequest(): any;
  requests: any[];
}

interface WireToolCall { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
interface WireMessage { role: string; content?: string | null; tool_calls?: WireToolCall[]; tool_call_id?: unknown; }
interface WireTool { type?: unknown; function?: { name?: unknown; parameters?: unknown } }
interface ChatBody { model: string; stream?: boolean; messages: WireMessage[]; tools?: WireTool[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What a strict OpenAI-compatible provider (e.g. Fireworks) rejects a request for, or null when
 * it's clean. Exists so this mock catches the wire-format mistakes a lenient local server would
 * silently accept — see the gateway.ts `toOpenAiMessages`/`toOpenAiTools` boundary this guards.
 */
function validationError(body: ChatBody): string | null {
  for (const t of body.tools ?? []) {
    if (t.type !== 'function' || typeof t.function?.name !== 'string' || t.function.parameters === undefined) {
      return `invalid tools entry, expected {type:'function', function:{name, parameters}}: ${JSON.stringify(t)}`;
    }
  }
  const knownToolCallIds = new Set<string>();
  for (const m of body.messages) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) {
        if (typeof tc.id !== 'string' || tc.type !== 'function' || typeof tc.function?.name !== 'string' || typeof tc.function?.arguments !== 'string') {
          return `invalid assistant tool_calls entry, expected {id, type:'function', function:{name, arguments:string}}: ${JSON.stringify(tc)}`;
        }
        knownToolCallIds.add(tc.id);
      }
    }
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !knownToolCallIds.has(m.tool_call_id))) {
      return `tool message tool_call_id does not match a preceding tool call: ${JSON.stringify(m)}`;
    }
  }
  return null;
}

// Splits a JSON string into at least 2 fragments (to exercise streamed-argument
// assembly on the consumer side); returns [text] unchanged when it can't be split.
function splitArguments(json: string): string[] {
  if (json.length < 2) return [json];
  const mid = Math.ceil(json.length / 2);
  return [json.slice(0, mid), json.slice(mid)];
}

export function createMockOpenAI(opts: MockOptions = {}): MockOpenAI {
  const { tokenDelayMs = 0, replyFor = (u) => `echo: ${u}`, script = [], strict = true } = opts;
  const app = Fastify() as unknown as MockOpenAI;
  const requests: any[] = [];
  app.requests = requests;
  app.lastRequest = () => requests[requests.length - 1];
  let stepIndex = 0;

  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as ChatBody;
    requests.push(body);
    if (strict) {
      const error = validationError(body);
      if (error) return reply.code(400).send({ error: { message: error } });
    }
    const step = stepIndex < script.length ? script[stepIndex++] : undefined;

    if (step && 'toolCalls' in step) {
      const toolCalls = step.toolCalls.map((tc, i) => ({ id: `call_${i}`, name: tc.name, arguments: JSON.stringify(tc.arguments) }));
      if (!body.stream) {
        return {
          id: 'mock-1', object: 'chat.completion', model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) },
            finish_reason: 'tool_calls',
          }],
        };
      }
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const fragments = splitArguments(tc.arguments);
        for (let f = 0; f < fragments.length; f++) {
          if (tokenDelayMs) await sleep(tokenDelayMs);
          const fnDelta: Record<string, unknown> = { arguments: fragments[f] };
          if (f === 0) fnDelta.name = tc.name;
          const toolCallDelta: Record<string, unknown> = { index: i, function: fnDelta };
          if (f === 0) { toolCallDelta.id = tc.id; toolCallDelta.type = 'function'; }
          const chunk = { id: 'mock-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [toolCallDelta] }, finish_reason: null }] };
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
      const finalChunk = { id: 'mock-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
      reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    }

    const lastMessage = body.messages[body.messages.length - 1];
    const full = step && 'content' in step
      ? step.content
      : lastMessage?.role === 'tool'
        ? `echo: ${lastMessage.content}`
        : replyFor([...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    if (!body.stream) {
      return {
        id: 'mock-1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
      };
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // split into whitespace-preserving tokens so concatenation reproduces `full`
    const tokens = full.match(/\S+\s*/g) ?? [];
    for (const tok of tokens) {
      if (tokenDelayMs) await sleep(tokenDelayMs);
      const chunk = { id: 'mock-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: tok }, finish_reason: null }] };
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });

  return app;
}
