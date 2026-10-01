import Fastify, { type FastifyInstance } from 'fastify';
import { gradientPng } from './png.js';

export interface ComfyMockOptions {
  /** `/history/<id>` stays empty for this many polls of that id, then reports the finished output. */
  pollsUntilDone?: number;
  /** `/history/<id>` stays empty for this many polls of that id, then reports a `status_str: 'error'` entry instead of completing. */
  failAfterPolls?: number;
}

export interface MockComfy extends FastifyInstance {
  /** Every workflow posted to `/prompt`, in order — lets tests assert placeholder substitution. */
  prompts: unknown[];
  polls: number;
  /** The bytes `/view` serves for a video workflow; also what a completed job's mp4 should contain. */
  videoBytes: Buffer;
  /** The png `/view` serves for the most recent image workflow (one with a `SaveImage` node). */
  imageBytes: Buffer;
}

// A 24-byte ISO-BMFF header — enough for a test to assert "this is the mp4 the mock served".
const STUB_MP4 = Buffer.from('00000018667479706d703432000000006d70343200000000', 'hex');

/** An image workflow is one whose output node saves an image; its text is what the picture is drawn from. */
function imageText(workflow: unknown): string | undefined {
  const nodes = Object.values((workflow ?? {}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>);
  if (!nodes.some((n) => n?.class_type === 'SaveImage')) return undefined;
  const text = nodes.map((n) => n?.inputs?.text).find((t) => typeof t === 'string');
  return typeof text === 'string' ? text : 'image';
}

/**
 * Minimal stand-in for the ComfyUI HTTP API: `/prompt`, `/history/:id` and `/view`. A workflow with
 * a `SaveImage` node finishes as `agenthub_<n>_.png` (a real png drawn from its prompt); any other
 * as `agenthub_00001.mp4`.
 */
export function createComfyMock(opts: ComfyMockOptions = {}): MockComfy {
  const { pollsUntilDone = 1, failAfterPolls } = opts;
  const app = Fastify() as unknown as MockComfy;
  app.prompts = [];
  app.polls = 0;
  app.videoBytes = STUB_MP4;
  app.imageBytes = gradientPng('image');

  const videoFile = 'agenthub_00001.mp4';
  const images = new Map<string, Buffer>();
  const outputs = new Map<string, string>();
  let counter = 0;

  app.post('/prompt', async (req) => {
    const body = (req.body ?? {}) as { prompt?: unknown };
    app.prompts.push(body.prompt);
    const id = `p${++counter}`;
    const text = imageText(body.prompt);
    if (text === undefined) {
      outputs.set(id, videoFile);
    } else {
      const name = `agenthub_${String(counter).padStart(5, '0')}_.png`;
      app.imageBytes = gradientPng(text);
      images.set(name, app.imageBytes);
      outputs.set(id, name);
    }
    return { prompt_id: id, number: counter, node_errors: {} };
  });

  /** Polls per prompt, so each run of a long-lived mock (the simulation's) takes its own time. */
  const pollsOf = new Map<string, number>();

  app.get('/history/:id', async (req) => {
    const { id } = req.params as { id: string };
    app.polls++;
    const polls = (pollsOf.get(id) ?? 0) + 1;
    pollsOf.set(id, polls);
    if (failAfterPolls !== undefined && polls > failAfterPolls) {
      return { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'mock node failure' }]] } } };
    }
    if (polls <= pollsUntilDone) return {}; // still running
    const filename = outputs.get(id) ?? videoFile;
    const key = filename.endsWith('.png') ? 'images' : 'gifs';
    return { [id]: { status: { completed: true }, outputs: { '4': { [key]: [{ filename, subfolder: '', type: 'output' }] } } } };
  });

  app.get('/view', async (req, reply) => {
    const { filename: f } = req.query as { filename?: string };
    const image = f ? images.get(f) : undefined;
    if (image) return reply.type('image/png').send(image);
    if (f !== videoFile) return reply.code(404).send({ error: 'not found' });
    return reply.type('video/mp4').send(app.videoBytes);
  });

  return app;
}
