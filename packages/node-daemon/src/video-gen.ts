import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoPayload, type JobResult, type VideoPayload } from '@agenthub/shared';

// The payload schema lives in @agenthub/shared because the hub validates it too (`POST /api/video`,
// `/video`, `generate_video`); re-exported here so this module stays the daemon's video surface.
export { parseVideoPayload, type VideoPayload };

export interface VideoGenOptions {
  comfyUrl: string;
  /** The ComfyUI API-format workflow JSON with `{{prompt}}`-style placeholders (see deploy/spark). */
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

/** Fills `{{prompt}}`, `{{mode}}`, `{{duration}}`, `{{aspect}}` and `{{resolution}}`. */
export function fillWorkflow(template: string, payload: VideoPayload): unknown {
  const filled = template
    .replaceAll('{{prompt}}', jsonFragment(payload.prompt))
    .replaceAll('{{mode}}', jsonFragment(payload.mode))
    .replaceAll('{{duration}}', String(payload.durationSec))
    .replaceAll('{{aspect}}', jsonFragment(payload.aspect))
    .replaceAll('{{resolution}}', jsonFragment(payload.resolution))
    .replaceAll('{{imagePath}}', jsonFragment(payload.imagePath ?? ''));
  try {
    return JSON.parse(filled);
  } catch (err) {
    throw new Error(`workflow template is not valid JSON after substitution: ${(err as Error).message}`);
  }
}

interface HistoryFile { filename: string; subfolder?: string; type?: string; }

/** ComfyUI keys video outputs by node id, under a per-node-type key (`gifs`, `videos`, `images`). */
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

/**
 * Runs one video job against a local ComfyUI: queue the filled workflow, poll `/history/<id>` until
 * the run has an output file, then download it to `<outDir>/<jobId>.mp4`.
 *
 * An abort (daemon stopping, hub fencing the job) resolves with `signal: 'aborted'`, matching
 * `runShellTask`. Any other failure throws, which the runner reports as a requeueable error.
 */
export async function runVideoGen(payload: VideoPayload, opts: VideoGenOptions): Promise<JobResult> {
  try {
    return await execute(payload, opts);
  } catch (err) {
    // An abort surfaces as whatever the in-flight fetch rejected with; report it as an abort, not a
    // requeueable ComfyUI failure.
    if (opts.signal?.aborted) return ABORTED;
    throw err;
  }
}

async function execute(payload: VideoPayload, opts: VideoGenOptions): Promise<JobResult> {
  if (opts.signal?.aborted) return ABORTED;
  const base = opts.comfyUrl.replace(/\/$/, '');
  const workflow = fillWorkflow(opts.workflowTemplate, payload);

  const queued = await fetch(`${base}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `agenthub-${opts.jobId}` }),
    signal: opts.signal,
  });
  if (!queued.ok) throw new Error(`comfy /prompt failed: ${queued.status}`);
  const promptId = ((await queued.json()) as { prompt_id?: string }).prompt_id;
  if (!promptId) throw new Error('comfy /prompt returned no prompt_id');
  opts.onLine(`[video] queued ${promptId} (${payload.mode}, ${payload.durationSec}s, ${payload.resolution})`);

  const deadline = Date.now() + (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let file: HistoryFile | undefined;
  for (;;) {
    if (opts.signal?.aborted) return ABORTED;
    const res = await fetch(`${base}/history/${promptId}`, { signal: opts.signal });
    if (res.ok) {
      const history = (await res.json()) as Record<string, unknown>;
      file = findOutputFile(history[promptId]);
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
  const path = join(opts.outDir, `${opts.jobId}.mp4`);
  writeFileSync(path, bytes);
  opts.onLine(`[video] wrote ${path} (${bytes.length} bytes)`);

  return { exitCode: 0, data: { path, durationSec: payload.durationSec } };
}
