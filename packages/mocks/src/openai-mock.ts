import Fastify, { type FastifyInstance } from 'fastify';

export interface MockOptions { tokenDelayMs?: number; replyFor?: (lastUser: string) => string; }

interface ChatBody { model: string; stream?: boolean; messages: { role: string; content: string }[]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockOpenAI(opts: MockOptions = {}): FastifyInstance {
  const { tokenDelayMs = 0, replyFor = (u) => `echo: ${u}` } = opts;
  const app = Fastify();

  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as ChatBody;
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const full = replyFor(lastUser);
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
