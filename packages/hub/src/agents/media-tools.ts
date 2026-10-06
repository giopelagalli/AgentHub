import { memberAbilities, type MediaKind, type TeamMember } from '@agenthub/shared';
import { findMediaByJob, MEDIA_DIR, mediaFileFor, type MediaDesk } from '../projects/media.js';
import type { Tool, ToolContext } from './tools.js';

/**
 * FR-E3 — an employee's `generate_image` / `generate_video`, one per media ability they have
 * (decision 0073). Each queues a render attributed to the
 * project through the same `MediaDesk` as the owner's prompt box, waits for the file to land in the
 * bundle's `media/`, and returns its path. The wait is bounded by the turn's own signal, and a job
 * no machine has picked up after ten minutes is left queued with the path it will land at; either
 * way the render still lands when it finishes.
 */

const POLL_MS = 1000;
/** How long a tool waits for a machine to pick its job up before handing the turn back. */
const QUEUED_CAP_MS = 10 * 60_000;

const PROPS = {
  prompt: { type: 'string', description: 'What to render: subject, style, colours, framing.' },
  negativePrompt: { type: 'string', description: 'What to keep out of it (optional).' },
  width: { type: 'integer', description: 'Pixels, a multiple of 16 between 256 and 2048.' },
  height: { type: 'integer', description: 'Pixels, a multiple of 16 between 256 and 2048.' },
  seed: { type: 'integer', description: 'Repeat a render exactly; omit for a fresh one.' },
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

async function generate(desk: MediaDesk, kind: MediaKind, args: unknown, ctx: ToolContext, timing: { pollMs: number; queuedCapMs: number }): Promise<string> {
  if (!ctx.bundle) return 'error: media needs a project';
  const { slug } = await ctx.bundle.manifest();
  const job = desk.request(slug, { ...(args && typeof args === 'object' ? args : {}), kind });
  ctx.log(`[media] queued ${kind} job ${job.id}`);
  const capAt = Date.now() + timing.queuedCapMs;
  for (;;) {
    const now = desk.job(job.id);
    if (now?.status === 'failed') return `error: the ${kind} render failed (job ${job.id}): ${now.error ?? 'no reason given'}`;
    if (now?.status === 'done') {
      const asset = await findMediaByJob(ctx.bundle.dir, job.id);
      if (!asset) return `error: job ${job.id} finished but no file landed in ${MEDIA_DIR}/`;
      const size = asset.params.width && asset.params.height ? `${asset.params.width}×${asset.params.height}` : '';
      const extra = [size, asset.params.seconds ? `${asset.params.seconds}s` : '', asset.params.seed !== undefined ? `seed ${asset.params.seed}` : '']
        .filter(Boolean).join(', ');
      return `${MEDIA_DIR}/${asset.file} (${extra}) — rendered on ${asset.node} in ${Math.round(asset.durationMs / 1000)} s`;
    }
    if (ctx.signal?.aborted) return `error: stopped waiting — job ${job.id} is still ${now?.status ?? 'queued'} and will land in ${MEDIA_DIR}/ when it finishes`;
    // A job no machine has picked up in this long is not worth holding the turn for; it stays
    // queued (0060) and lands on its own. One that is rendering is waited for.
    if (now?.status === 'queued' && Date.now() >= capAt) {
      return `job ${job.id} is still queued — it will land in ${MEDIA_DIR}/${mediaFileFor(job)} when a machine renders it`;
    }
    await sleep(timing.pollMs, ctx.signal);
  }
}

/** The render tools for `kinds` (both when omitted), in `generate_image`, `generate_video` order. */
export function mediaTools(
  desk: MediaDesk, opts: { pollMs?: number; queuedCapMs?: number; kinds?: readonly MediaKind[] } = {},
): Tool[] {
  const timing = { pollMs: opts.pollMs ?? POLL_MS, queuedCapMs: opts.queuedCapMs ?? QUEUED_CAP_MS };
  const kinds = opts.kinds ?? ['image', 'video'];
  const tools: (Tool & { kind: MediaKind })[] = [
    {
      def: {
        type: 'tool', name: 'generate_image',
        description: 'Render one still image (Qwen-Image) into the project\'s media/ folder; waits for it and returns its path.',
        parameters: { type: 'object', properties: PROPS, required: ['prompt'] },
      },
      run: (args, ctx) => generate(desk, 'image', args, ctx, timing),
      kind: 'image',
    },
    {
      def: {
        type: 'tool', name: 'generate_video',
        description: 'Render one short clip (Wan 2.2) into the project\'s media/ folder; waits for it and returns its path. Slow — minutes.',
        parameters: {
          type: 'object',
          properties: {
            ...PROPS,
            seconds: { type: 'integer', description: 'Length, 4–15; defaults to 5.' },
            fps: { type: 'integer', description: 'Frames per second, 8–30; defaults to 16.' },
          },
          required: ['prompt'],
        },
      },
      run: (args, ctx) => generate(desk, 'video', args, ctx, timing),
      kind: 'video',
    },
  ];
  return tools.filter((t) => kinds.includes(t.kind)).map(({ def, run }) => ({ def, run }));
}

/**
 * The render tools a delegated employee works with: one per media ability (decision 0073), none
 * without a media desk. Only `spawn_subagent` hands these out — never the manager's own belt or
 * the milestone reviewer's pinned one.
 */
export function memberMediaTools(member: Pick<TeamMember, 'role' | 'abilities'>, desk: MediaDesk | undefined): Tool[] {
  const kinds = memberAbilities(member);
  return desk && kinds.length ? mediaTools(desk, { kinds }) : [];
}
