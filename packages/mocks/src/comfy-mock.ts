import Fastify, { type FastifyInstance } from 'fastify';

export interface ComfyMockOptions {
  /** `/history/<id>` stays empty for this many polls, then reports the finished output. */
  pollsUntilDone?: number;
  /** `/history/<id>` stays empty for this many polls, then reports a `status_str: 'error'` entry instead of completing. */
  failAfterPolls?: number;
}

export interface MockComfy extends FastifyInstance {
  /** Every workflow posted to `/prompt`, in order — lets tests assert placeholder substitution. */
  prompts: unknown[];
  polls: number;
  /** The bytes `/view` serves; also what a completed job's mp4 should contain. */
  videoBytes: Buffer;
}

// A 24-byte ISO-BMFF header — enough for a test to assert "this is the mp4 the mock served".
const STUB_MP4 = Buffer.from('00000018667479706d703432000000006d70343200000000', 'hex');

/** Minimal stand-in for the ComfyUI HTTP API: `/prompt`, `/history/:id` and `/view`. */
export function createComfyMock(opts: ComfyMockOptions = {}): MockComfy {
  const { pollsUntilDone = 1, failAfterPolls } = opts;
  const app = Fastify() as unknown as MockComfy;
  app.prompts = [];
  app.polls = 0;
  app.videoBytes = STUB_MP4;

  const filename = 'agenthub_00001.mp4';
  let counter = 0;

  app.post('/prompt', async (req) => {
    const body = (req.body ?? {}) as { prompt?: unknown };
    app.prompts.push(body.prompt);
    return { prompt_id: `p${++counter}`, number: counter, node_errors: {} };
  });

  app.get('/history/:id', async (req) => {
    const { id } = req.params as { id: string };
    app.polls++;
    if (failAfterPolls !== undefined && app.polls > failAfterPolls) {
      return { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'mock node failure' }]] } } };
    }
    if (app.polls <= pollsUntilDone) return {}; // still running
    return { [id]: { status: { completed: true }, outputs: { '4': { gifs: [{ filename, subfolder: '', type: 'output' }] } } } };
  });

  app.get('/view', async (req, reply) => {
    const { filename: f } = req.query as { filename?: string };
    if (f !== filename) return reply.code(404).send({ error: 'not found' });
    return reply.type('video/mp4').send(app.videoBytes);
  });

  return app;
}
