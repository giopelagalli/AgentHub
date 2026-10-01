import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { JdMessage, JdStreamFrame } from '@agenthub/shared';

/**
 * A stand-in for JD's web API (decision 0069), every route with canned behaviour, so the hub's
 * proxy and the JD page can be built and seen without telegramManager running:
 *
 *  - `POST /messages` echoes the owner and answers; a message mentioning "button" (or the "Check in"
 *    key) is answered with an inline keyboard, "link" with a formatted reply, "slow" after a pause.
 *  - `POST /callback` answers a tap with an `edit: true` of the message that carried the keyboard.
 *  - `POST /voice` hears a fixed transcript and answers with a voice reply (a short WAV it serves).
 *  - `WS /stream` pushes typing and a proactive message every `proactiveMs` to each open socket.
 *
 * Every route checks the bearer, as JD's does.
 */

export interface JdMockOptions {
  token: string;
  /** The display name `/health` reports. Default `JD`. */
  name?: string;
  /** How often each open `/stream` gets a proactive message; 0 turns them off. Default 20 s. */
  proactiveMs?: number;
  /** How long the canned replies "think", with typing on the stream meanwhile. Default 600 ms. */
  replyDelayMs?: number;
  /** Seed `/history` with a short conversation. Default true. */
  seed?: boolean;
}

export interface MockJd extends FastifyInstance {
  /** The conversation, oldest first — edits applied in place. */
  conversation: JdMessage[];
  /** Every body `/voice` received, with its content type. */
  voices: { type: string; bytes: Buffer }[];
  /** Pushes a frame to every open `/stream`. */
  push(frame: JdStreamFrame): void;
  /** How many `/stream` sockets are open. */
  streams(): number;
}

export const JD_MOCK_KEYS = ['Plan my day', 'What’s on today?', 'Check in', 'Projects'];
export const JD_MOCK_TRANSCRIPT = 'Remind me to call the bank tomorrow at ten.';
const MAX_BODY = 10 * 1024 * 1024;

/** A short two-note chime as 16-bit mono PCM WAV — a real file every browser plays. */
export function chimeWav(seconds = 0.9, rate = 16000): Buffer {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const f = t < seconds / 2 ? 660 : 880;
    const env = Math.min(1, t * 40) * Math.max(0, 1 - t / seconds);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * env * 0.35 * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PROACTIVE = [
  '<b>Check-in.</b> Demo’s roadmap moved: milestone 2 is done, milestone 3 starts tonight.',
  'Heads up — your 3 pm moved to 3:30. Nothing else changes today.',
  '<b>Project report</b>\nhabit-tracker: 2 turns since lunch, tests green.\npomodoro-cli: waiting on you for the PRD.',
  'You asked me to nudge you: stretch, water, then the inbox.',
];

export function createMockJd(opts: JdMockOptions): MockJd {
  const name = opts.name ?? 'JD';
  const proactiveMs = opts.proactiveMs ?? 20_000;
  const replyDelayMs = opts.replyDelayMs ?? 600;
  const app = Fastify({ bodyLimit: MAX_BODY }) as unknown as MockJd;
  const sockets = new Set<WebSocket>();
  const audio = new Map<string, { mime: string; bytes: Buffer }>([['chime', { mime: 'audio/wav', bytes: chimeWav() }]]);
  let seq = 0;
  const id = (): string => `m${++seq}`;
  app.conversation = [];
  app.voices = [];

  const say = (from: JdMessage['from'], text: string, extra: Partial<JdMessage> = {}): JdMessage => {
    const message: JdMessage = { id: id(), from, at: Date.now(), text, format: from === 'jd' ? 'html' : 'plain', ...extra };
    app.conversation.push(message);
    return message;
  };

  if (opts.seed ?? true) {
    const day = Date.now() - 3 * 3600_000;
    const seeded: Omit<JdMessage, 'id'>[] = [
      { from: 'jd', at: day, format: 'html', text: '<b>Good morning.</b> Three things today:\n• Demo: review the roadmap\n• Call with Sara at 11\n• Gym at 6' },
      { from: 'owner', at: day + 60_000, format: 'plain', text: 'Move the gym to 7, I’ll be late.' },
      { from: 'jd', at: day + 75_000, format: 'html', text: 'Done — gym is at <b>7 pm</b>. I’ll remind you at 6:30.' },
    ];
    for (const m of seeded) app.conversation.push({ id: id(), ...m });
  }

  app.push = (frame) => {
    const text = JSON.stringify(frame);
    for (const socket of sockets) socket.send(text);
  };
  app.streams = () => sockets.size;
  const typing = (on: boolean): void => app.push({ type: 'typing', on });
  const think = async (ms = replyDelayMs): Promise<void> => {
    typing(true);
    await new Promise((r) => setTimeout(r, ms));
    typing(false);
  };

  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${opts.token}`) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.register(websocket);

  app.get('/health', async () => ({ ok: true, name }));
  app.get('/history', async (req) => {
    const limit = Math.max(1, Math.min(200, Number((req.query as { limit?: string }).limit ?? 50) || 50));
    return { messages: app.conversation.slice(-limit) };
  });
  app.get('/keys', async () => ({ keys: JD_MOCK_KEYS }));

  app.post('/messages', async (req, reply) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'text is required' });
    const own = say('owner', text);
    await think(/slow/i.test(text) ? 3000 : replyDelayMs);
    let answer: JdMessage;
    if (/button|check in/i.test(text)) {
      answer = say('jd', 'How did the morning go?', {
        buttons: [[{ label: 'Great', data: 'mood:great' }, { label: 'Fine', data: 'mood:fine' }, { label: 'Rough', data: 'mood:rough' }], [{ label: 'Ask me later', data: 'mood:later' }]],
      });
    } else if (/link/i.test(text)) {
      answer = say('jd', 'Here’s the <a href="https://example.com/notes">meeting notes</a>. The command was <code>npm run sim</code>:\n<pre>npm run sim\nopen http://127.0.0.1:4100</pre>');
    } else if (/projects/i.test(text)) {
      answer = say('jd', '<b>Projects</b>\nDemo — <i>running a turn</i>\nhabit-tracker — idle\npomodoro-cli — <u>needs you</u>');
    } else {
      answer = say('jd', `Noted: “${escape(text)}”. I’ll keep it in mind.`);
    }
    return { messages: [own, answer] };
  });

  app.post('/callback', async (req, reply) => {
    const data = (req.body as { data?: unknown } | undefined)?.data;
    if (typeof data !== 'string') return reply.code(400).send({ error: 'data is required' });
    let at = app.conversation.length - 1;
    while (at >= 0 && !app.conversation[at]!.buttons?.some((row) => row.some((b) => b.data === data))) at--;
    if (at < 0) return { messages: [] };
    const label = app.conversation[at]!.buttons!.flat().find((b) => b.data === data)!.label;
    const { buttons: _gone, ...rest } = app.conversation[at]!;
    const edited: JdMessage = { ...rest, text: `${rest.text}\n<i>You said: ${escape(label)}.</i>`, format: 'html' };
    app.conversation[at] = edited;
    return { messages: [{ ...edited, edit: true }] };
  });

  app.post('/voice', async (req, reply) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return reply.code(400).send({ error: 'audio body required' });
    app.voices.push({ type: String(req.headers['content-type']), bytes });
    const own = say('owner', JD_MOCK_TRANSCRIPT);
    await think();
    const answer = say('jd', 'Got it — I’ll remind you <b>tomorrow at 10:00</b> to call the bank.', { audio: { id: 'chime', mime: 'audio/wav' } });
    return { transcript: JD_MOCK_TRANSCRIPT, messages: [own, answer] };
  });

  app.get('/audio/:id', async (req, reply) => {
    const clip = audio.get((req.params as { id: string }).id);
    if (!clip) return reply.code(404).send({ error: 'no such audio' });
    return reply.type(clip.mime).send(clip.bytes);
  });

  app.register(async (scope) => {
    scope.get('/stream', { websocket: true }, (socket: WebSocket) => {
      sockets.add(socket);
      let turn = 0;
      const timer = proactiveMs > 0
        ? setInterval(() => {
            const text = PROACTIVE[turn++ % PROACTIVE.length]!;
            socket.send(JSON.stringify({ type: 'typing', on: true } satisfies JdStreamFrame));
            setTimeout(() => {
              if (socket.readyState !== socket.OPEN) return;
              socket.send(JSON.stringify({ type: 'typing', on: false } satisfies JdStreamFrame));
              socket.send(JSON.stringify({ type: 'message', message: say('jd', text) } satisfies JdStreamFrame));
            }, 1500);
          }, proactiveMs)
        : undefined;
      socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
    });
  });

  app.addHook('onClose', async () => {
    for (const socket of sockets) socket.terminate();
  });
  return app;
}
