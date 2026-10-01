import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  imagePayloadFrom, isMediaJob, VIDEO_ASPECTS, VIDEO_MEDIA_DEFAULTS, videoPayloadFrom,
  type ImagePayload, type Job, type JobSpec, type JobType, type MediaAsset, type MediaKind, type MediaList, type VideoPayload,
} from '@agenthub/shared';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { ProjectBundle } from './bundle.js';

/**
 * Project media (FR-E2): every finished `image-gen` / `video-gen` job attributed to a project lands
 * in the bundle as `media/<id>.<ext>` beside a sidecar `media/<id>.json`, and is committed. This
 * module is the bundle side (land, list, resolve a file) plus `MediaDesk`, the one place a media
 * request becomes a queued job — the owner's route and the designer's tools both go through it.
 */

export const MEDIA_DIR = 'media';

/** Clips default to Wan 2.2's native 5 s. */
export const MEDIA_VIDEO_SECONDS = 5;

const KIND: Record<string, MediaKind> = { 'image-gen': 'image', 'video-gen': 'video' };
const EXT: Record<MediaKind, string> = { image: 'png', video: 'mp4' };

/** What `GET …/media/:file` will serve, by extension — media only, never the sidecars. */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm',
};

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const mediaKind = (type: JobType): MediaKind => KIND[type] ?? 'image';

/** The file a media job's output is named by in the bundle: `image-12.png`. */
export const mediaFileFor = (job: Pick<Job, 'id' | 'type'>, id = `${mediaKind(job.type)}-${job.id}`): string =>
  `${id}.${EXT[mediaKind(job.type)]}`;

/** The sidecar's view of a job's parameters — the media-facing names (`seconds`, not `durationSec`). */
function paramsOf(job: Job): MediaAsset['params'] {
  const p = job.payload as Partial<ImagePayload & VideoPayload>;
  const pick = { negativePrompt: p.negativePrompt, width: p.width, height: p.height, seed: p.seed,
    ...(job.type === 'video-gen' ? { seconds: p.durationSec, fps: p.fps } : {}) };
  return Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined));
}

async function readSidecar(path: string): Promise<MediaAsset | null> {
  try {
    const a = JSON.parse(await readFile(path, 'utf8')) as MediaAsset;
    return a && typeof a.file === 'string' && typeof a.id === 'string' ? a : null;
  } catch {
    return null;
  }
}

/** Every asset with a readable sidecar, newest first. A file without one is not listed. */
export async function listMedia(bundleDir: string): Promise<MediaAsset[]> {
  const dir = join(bundleDir, MEDIA_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const assets = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readSidecar(join(dir, n))));
  return assets.filter((a): a is MediaAsset => !!a).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

export async function findMediaByJob(bundleDir: string, jobId: number): Promise<MediaAsset | null> {
  return (await listMedia(bundleDir)).find((a) => a.jobId === jobId) ?? null;
}

/**
 * `media/`'s real path, refused (thrown) when it resolves outside the bundle — `media` itself can be
 * a symlink in a cloned bundle, and then neither serving from it nor writing into it is safe.
 */
async function mediaDirIn(bundleDir: string): Promise<string> {
  const root = await realpath(bundleDir);
  const dir = await realpath(join(bundleDir, MEDIA_DIR));
  if (!dir.startsWith(root + sep)) throw new Error(`${MEDIA_DIR}/ resolves outside the bundle`);
  return dir;
}

/** Writes beside the target and renames over it: never through a symlink, never a half-written file. */
async function replaceFile(dir: string, name: string, data: Buffer | string): Promise<void> {
  const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, data);
  await rename(temp, join(dir, name));
}

/** A prompt as one line for a commit subject: whitespace collapsed, at most 60 characters. */
export function commitLabel(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/**
 * The absolute path of a servable file under `media/`, or null. The name must be a plain file name
 * with a media extension, and its real path (symlinks followed) must still sit inside `media/` —
 * a bundle is a git repo that can be cloned, so a link out of it is not ruled out by the name alone.
 */
export async function mediaFilePath(bundleDir: string, file: string): Promise<{ path: string; contentType: string } | null> {
  if (!FILE_RE.test(file) || file.includes('..')) return null;
  const contentType = MEDIA_CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
  if (!contentType) return null;
  try {
    const dir = await mediaDirIn(bundleDir);
    const path = await realpath(join(dir, file));
    if (!path.startsWith(dir + sep) || !(await lstat(path)).isFile()) return null;
    return { path, contentType };
  } catch {
    return null;
  }
}

/**
 * Writes a finished job's bytes and its sidecar into the bundle and commits both. The id follows
 * the job (`image-12`); should a sidecar by that name already belong to another job — a hub whose
 * database was reset under old bundles — the new asset gets the job's creation time appended
 * rather than overwriting the old one.
 */
export async function landMedia(bundle: ProjectBundle, job: Job, bytes: Buffer, node: string, now = Date.now()): Promise<MediaAsset> {
  await mkdir(join(bundle.dir, MEDIA_DIR), { recursive: true });
  const dir = await mediaDirIn(bundle.dir);
  let id = `${mediaKind(job.type)}-${job.id}`;
  const existing = await readSidecar(join(dir, `${id}.json`));
  if (existing && existing.jobId !== job.id) id = `${id}-${job.createdAt.toString(36)}`;
  const asset: MediaAsset = {
    id, file: mediaFileFor(job, id), kind: mediaKind(job.type),
    prompt: (job.payload as { prompt?: string }).prompt ?? '',
    params: paramsOf(job), jobId: job.id, node,
    // `updatedAt` is the claim — the last time the row changed before this upload.
    durationMs: Math.max(0, now - job.updatedAt),
    createdAt: now, bytes: bytes.length,
  };
  await replaceFile(dir, asset.file, bytes);
  await replaceFile(dir, `${id}.json`, `${JSON.stringify(asset, null, 2)}\n`);
  await bundle.commit(`media: ${asset.file} — ${commitLabel(asset.prompt)}`);
  return asset;
}

/** The closest of the legacy aspect names to a width × height, for templates that still read `{{aspect}}`. */
function nearestAspect(width: number, height: number): VideoPayload['aspect'] {
  const ratio = (a: string) => { const [w, h] = a.split(':').map(Number); return w! / h!; };
  return [...VIDEO_ASPECTS].sort((a, b) => Math.abs(ratio(a) - width / height) - Math.abs(ratio(b) - width / height))[0]!;
}

export class MediaRequestError extends Error {}
/** The request is fine; no registered machine renders that kind. */
export class NoRendererError extends MediaRequestError {}

const RECENT_FAILURE_MS = 15 * 60_000;

export interface MediaDeskDeps {
  queue: JobQueue;
  registry: NodeRegistry;
  /** Called after a job is queued — the hub broadcasts its state. */
  onChange?: () => void;
  /** Swapped in tests. */
  seed?: () => number;
}

/** Turns media requests into queued jobs and answers what a project's media panel shows. */
export class MediaDesk {
  constructor(private deps: MediaDeskDeps) {}

  /** Which media job types some registered node offers (online or not — it may be restarting). */
  renderers(): MediaList['renderers'] {
    const offers = (t: JobType) => this.deps.registry.all().some((n) => n.video && n.jobTypes.includes(t));
    return { image: offers('image-gen'), video: offers('video-gen') };
  }

  /**
   * Validates a `MediaRequest` and queues it for `slug`. The hub picks the seed when the caller
   * names none, so the sidecar always records the one that made the picture. Throws
   * `MediaRequestError` on a malformed request or when no machine renders that kind at all — a job
   * nobody can claim would otherwise sit in the queue forever.
   */
  request(slug: string, raw: unknown): Job {
    const spec = this.spec(raw);
    const kind = mediaKind(spec.type);
    if (!this.renderers()[kind]) throw new NoRendererError(`no machine can render ${kind === 'image' ? 'images' : 'video'} yet — see Help → Media`);
    const job = this.deps.queue.enqueue({ ...spec, project: slug });
    this.deps.onChange?.();
    return job;
  }

  /** The job a request would queue, or a `MediaRequestError`. */
  spec(raw: unknown): JobSpec {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r !== 'object' || (r.kind !== 'image' && r.kind !== 'video')) throw new MediaRequestError('kind must be image or video');
    if (typeof r.prompt !== 'string' || !r.prompt.trim()) throw new MediaRequestError('a prompt is required');
    const seed = r.seed ?? (this.deps.seed ?? (() => Math.floor(Math.random() * 2 ** 32)))();
    const common = { prompt: r.prompt.trim(), negativePrompt: r.negativePrompt, width: r.width, height: r.height, seed };
    if (r.kind === 'image') {
      const payload = imagePayloadFrom(common);
      if (!payload) throw new MediaRequestError('invalid image request');
      return { type: 'image-gen', tier: 'video-gen', priority: 'project', payload };
    }
    const width = typeof r.width === 'number' ? r.width : VIDEO_MEDIA_DEFAULTS.width;
    const height = typeof r.height === 'number' ? r.height : VIDEO_MEDIA_DEFAULTS.height;
    const payload = videoPayloadFrom({
      ...common, width, height, aspect: nearestAspect(width, height),
      durationSec: r.seconds ?? MEDIA_VIDEO_SECONDS, fps: r.fps ?? VIDEO_MEDIA_DEFAULTS.fps,
    });
    if (!payload) throw new MediaRequestError('invalid video request');
    return { type: 'video-gen', tier: 'video-gen', priority: 'project', payload };
  }

  job(id: number): Job | null {
    return this.deps.queue.get(id);
  }

  /** This project's media jobs in flight, plus the ones that failed recently enough to still explain. */
  jobs(slug: string, now = Date.now()): MediaList['jobs'] {
    return this.deps.queue.list()
      .filter((j) => j.project === slug && isMediaJob(j.type)
        && (j.status === 'queued' || j.status === 'running' || (j.status === 'failed' && now - j.updatedAt < RECENT_FAILURE_MS)))
      .map((j) => ({
        jobId: j.id, kind: mediaKind(j.type), prompt: (j.payload as { prompt?: string }).prompt ?? '', status: j.status, createdAt: j.createdAt,
        ...(j.error ? { error: j.error } : {}),
      }));
  }
}
