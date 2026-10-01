import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImagePayload, parseVideoPayload, VIDEO_MEDIA_DEFAULTS, type ImagePayload, type JobResult, type VideoPayload } from '@agenthub/shared';

// The payload schemas live in @agenthub/shared because the hub validates them too (`POST /api/video`,
// `/video`, `generate_video`, the project media routes); re-exported here so this module stays the
// daemon's ComfyUI surface — `video-gen` and `image-gen` both run through it.
export { parseImagePayload, parseVideoPayload, type ImagePayload, type VideoPayload };

/** A ComfyUI run that failed mid-workflow — requeueing it would burn another GPU hour on the same broken workflow. */
export class ComfyExecutionError extends Error {}

export interface VideoGenOptions {
  comfyUrl: string;
  /** The ComfyUI API-format workflow JSON with `{{prompt}}`-style placeholders (see deploy/amd/comfy). */
  workflowTemplate: string;
  outDir: string;
  jobId: number;
  onLine: (line: string) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Bounds the whole poll loop; a 15s 1080p clip is ~12 min on the Spark (PRD §11). */
  maxWaitMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;

const ABORTED: JobResult = { exitCode: undefined, signal: 'aborted', timedOut: false };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-escapes a value so it can be substituted inside a quoted string in the template. */
function jsonFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Replaces every `{{name}}` with its value — a string JSON-escaped (it sits inside quotes in the
 * template), a number as-is (it sits bare) — and parses the result.
 */
function fill(template: string, values: Record<string, string | number>): unknown {
  let filled = template;
  for (const [name, value] of Object.entries(values)) {
    filled = filled.replaceAll(`{{${name}}}`, typeof value === 'number' ? String(value) : jsonFragment(value));
  }
  try {
    return JSON.parse(filled);
  } catch (err) {
    throw new Error(`workflow template is not valid JSON after substitution: ${(err as Error).message}`);
  }
}

/**
 * Fills a video template. The MiniMax-H3 placeholders (`{{mode}}`, `{{duration}}`, `{{aspect}}`,
 * `{{resolution}}`, `{{imagePath}}`) and the Wan 2.2 / LTX-2 ones (`{{negativePrompt}}`,
 * `{{width}}`, `{{height}}`, `{{seed}}`, `{{seconds}}`, `{{fps}}`, `{{frames}}`) are all offered;
 * a template uses the ones its nodes take.
 */
export function fillWorkflow(template: string, payload: VideoPayload, seed = payload.seed ?? 0): unknown {
  const fps = payload.fps ?? VIDEO_MEDIA_DEFAULTS.fps;
  return fill(template, {
    prompt: payload.prompt,
    mode: payload.mode,
    duration: payload.durationSec,
    aspect: payload.aspect,
    resolution: payload.resolution,
    imagePath: payload.imagePath ?? '',
    negativePrompt: payload.negativePrompt ?? '',
    width: payload.width ?? VIDEO_MEDIA_DEFAULTS.width,
    height: payload.height ?? VIDEO_MEDIA_DEFAULTS.height,
    seed,
    seconds: payload.durationSec,
    fps,
    // Wan and LTX count frames as 4k+1 (81 at 16 fps is 5 s).
    frames: Math.round((payload.durationSec * fps) / 4) * 4 + 1,
  });
}

/** Fills an image template: `{{prompt}}`, `{{negativePrompt}}`, `{{width}}`, `{{height}}`, `{{seed}}`. */
export function fillImageWorkflow(template: string, payload: ImagePayload, seed = payload.seed ?? 0): unknown {
  return fill(template, {
    prompt: payload.prompt,
    negativePrompt: payload.negativePrompt ?? '',
    width: payload.width,
    height: payload.height,
    seed,
  });
}

/**
 * The seed a run uses: the payload's, or — when it named none and the template has a `{{seed}}` —
 * a fresh one that the result then reports, so the asset can be rendered again exactly.
 */
function seedFor(template: string, given: number | undefined): { seed: number; picked: boolean } {
  if (given !== undefined) return { seed: given, picked: false };
  if (!template.includes('{{seed}}')) return { seed: 0, picked: false };
  return { seed: Math.floor(Math.random() * 2 ** 32), picked: true };
}

interface HistoryFile { filename: string; subfolder?: string; type?: string; }
interface HistoryStatus { status_str?: string; messages?: unknown[]; }

/**
 * A ComfyUI run that failed mid-workflow (a bad node, an OOM) reports `status_str: 'error'` in its
 * history entry and never gets an output file — polling on would just burn the full `maxWaitMs`.
 * Returns the error text to report, or undefined when the entry isn't a failure.
 */
function findError(entry: unknown): string | undefined {
  const status = (entry as { status?: HistoryStatus } | undefined)?.status;
  if (status?.status_str !== 'error') return undefined;
  const messages = Array.isArray(status.messages) ? status.messages : [];
  return messages.length > 0 ? JSON.stringify(messages) : 'comfy reported status_str: error';
}

/** ComfyUI keys outputs by node id, under a per-node-type key (`gifs`, `videos`, `images`). */
function findOutputFile(entry: unknown): HistoryFile | undefined {
  const outputs = (entry as { outputs?: Record<string, Record<string, HistoryFile[]>> } | undefined)?.outputs;
  if (!outputs) return undefined;
  for (const node of Object.values(outputs)) {
    for (const files of Object.values(node)) {
      if (Array.isArray(files) && files[0]?.filename) return files[0];
    }
  }
  return undefined;
}

/** What differs between an image run and a video run; everything else is the same ComfyUI round trip. */
interface ComfyRun {
  workflow: unknown;
  /** The extension the downloaded file is written with — fixed by the job type, not by ComfyUI. */
  ext: 'png' | 'mp4';
  tag: string;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Runs one video job against a local ComfyUI: queue the filled workflow, poll `/history/<id>` until
 * the run has an output file, then download it to `<outDir>/<jobId>.mp4`.
 *
 * An abort (daemon stopping, hub fencing the job) resolves with `signal: 'aborted'`, matching
 * `runShellTask`. Any other failure throws, which the runner reports as a requeueable error.
 */
export async function runVideoGen(payload: VideoPayload, opts: VideoGenOptions): Promise<JobResult> {
  return guarded(opts, () => {
    const { seed, picked } = seedFor(opts.workflowTemplate, payload.seed);
    return {
      workflow: fillWorkflow(opts.workflowTemplate, payload, seed),
      ext: 'mp4', tag: 'video',
      summary: `${payload.mode}, ${payload.durationSec}s, ${payload.width && payload.height ? `${payload.width}×${payload.height}` : payload.resolution}`,
      data: { durationSec: payload.durationSec, ...(picked ? { seed } : {}) },
    };
  });
}

/** `runVideoGen` for a still: the same round trip, written to `<outDir>/<jobId>.png`. */
export async function runImageGen(payload: ImagePayload, opts: VideoGenOptions): Promise<JobResult> {
  return guarded(opts, () => {
    const { seed, picked } = seedFor(opts.workflowTemplate, payload.seed);
    return {
      workflow: fillImageWorkflow(opts.workflowTemplate, payload, seed),
      ext: 'png', tag: 'image',
      summary: `${payload.width}×${payload.height}`,
      data: picked ? { seed } : {},
    };
  });
}

async function guarded(opts: VideoGenOptions, prepare: () => ComfyRun): Promise<JobResult> {
  try {
    if (opts.signal?.aborted) return ABORTED;
    return await execute(prepare(), opts);
  } catch (err) {
    // An abort surfaces as whatever the in-flight fetch rejected with; report it as an abort, not a
    // requeueable ComfyUI failure.
    if (opts.signal?.aborted) return ABORTED;
    throw err;
  }
}

async function execute(run: ComfyRun, opts: VideoGenOptions): Promise<JobResult> {
  const base = opts.comfyUrl.replace(/\/$/, '');

  const queued = await fetch(`${base}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: run.workflow, client_id: `agenthub-${opts.jobId}` }),
    signal: opts.signal,
  });
  if (!queued.ok) throw new Error(`comfy /prompt failed: ${queued.status}`);
  const promptId = ((await queued.json()) as { prompt_id?: string }).prompt_id;
  if (!promptId) throw new Error('comfy /prompt returned no prompt_id');
  opts.onLine(`[${run.tag}] queued ${promptId} (${run.summary})`);

  const deadline = Date.now() + (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let file: HistoryFile | undefined;
  for (;;) {
    if (opts.signal?.aborted) return ABORTED;
    const res = await fetch(`${base}/history/${promptId}`, { signal: opts.signal });
    if (res.ok) {
      const history = (await res.json()) as Record<string, unknown>;
      const entry = history[promptId];
      const error = findError(entry);
      if (error) throw new ComfyExecutionError(`comfy job failed: ${error}`);
      file = findOutputFile(entry);
      if (file) break;
    }
    if (Date.now() > deadline) return { exitCode: undefined, signal: 'timeout', timedOut: true };
    await sleep(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    if (opts.signal?.aborted) return ABORTED;
  }

  const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
  const view = await fetch(`${base}/view?${params}`, { signal: opts.signal });
  if (!view.ok) throw new Error(`comfy /view failed: ${view.status}`);
  const bytes = Buffer.from(await view.arrayBuffer());

  mkdirSync(opts.outDir, { recursive: true });
  const path = join(opts.outDir, `${opts.jobId}.${run.ext}`);
  writeFileSync(path, bytes);
  opts.onLine(`[${run.tag}] wrote ${path} (${bytes.length} bytes)`);

  return { exitCode: 0, data: { path, ...run.data } };
}
