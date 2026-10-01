import type { MediaAsset, MediaKind, MediaList, MediaRequest } from '@agenthub/shared';

/**
 * The Media view's model (FR-E2). Pure — the view, and the tests, read it: which sizes the prompt
 * box offers, what each asset's caption says, what a job's line says, and when nothing can render.
 */

export interface SizePreset { id: string; label: string; width: number; height: number }

/** Sizes on the 16-pixel grid the templates want; the first is the default. */
export const SIZE_PRESETS: Record<MediaKind, readonly SizePreset[]> = {
  image: [
    { id: 'square', label: 'Square', width: 1024, height: 1024 },
    { id: 'landscape', label: 'Landscape', width: 1344, height: 768 },
    { id: 'portrait', label: 'Portrait', width: 768, height: 1344 },
    { id: 'icon', label: 'Icon', width: 512, height: 512 },
  ],
  video: [
    { id: 'landscape', label: 'Landscape', width: 832, height: 480 },
    { id: 'portrait', label: 'Portrait', width: 480, height: 832 },
    { id: 'square', label: 'Square', width: 640, height: 640 },
  ],
};

/** Clip lengths the box offers, in seconds; Wan 2.2's native 5 s first. */
export const CLIP_SECONDS = [5, 8, 10] as const;

/** Where the grid loads a file from — the owner-only, contained `GET …/media/:file`. */
export const mediaUrl = (slug: string, file: string): string =>
  `/api/projects/${encodeURIComponent(slug)}/media/${encodeURIComponent(file)}`;

/** The request the prompt box sends. */
export function mediaRequest(kind: MediaKind, prompt: string, presetId: string, seconds: number): MediaRequest {
  const preset = SIZE_PRESETS[kind].find((p) => p.id === presetId) ?? SIZE_PRESETS[kind][0]!;
  return {
    kind, prompt: prompt.trim(), width: preset.width, height: preset.height,
    ...(kind === 'video' ? { seconds } : {}),
  };
}

const seconds = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** The small line under an asset: "1024×1024 · 5 s · seed 42 · 38 s on pc". */
export function assetCaption(asset: MediaAsset): string {
  const p = asset.params;
  return [
    p.width && p.height ? `${p.width}×${p.height}` : '',
    asset.kind === 'video' && p.seconds ? `${p.seconds} s${p.fps ? ` at ${p.fps} fps` : ''}` : '',
    p.seed !== undefined ? `seed ${p.seed}` : '',
    asset.node ? `${seconds(asset.durationMs)} on ${asset.node}` : '',
  ].filter(Boolean).join(' · ');
}

/** What a job in flight (or just failed) says about itself. */
export function jobLine(job: MediaList['jobs'][number]): string {
  if (job.status === 'running') return job.kind === 'image' ? 'Rendering…' : 'Rendering — clips take several minutes…';
  if (job.status === 'failed') return `Failed: ${job.error ?? 'no reason given'}`;
  return 'Waiting for the GPU machine…';
}

/** Why the prompt box cannot send `kind`, or null when it can. */
export function blockedReason(list: MediaList | null, kind: MediaKind): string | null {
  if (!list || list.renderers[kind]) return null;
  return `No machine can render ${kind === 'image' ? 'images' : 'video'} yet — see Help → Media.`;
}

/** Whether the view should poll quickly: something is still on its way. */
export const hasJobsInFlight = (list: MediaList | null): boolean =>
  !!list?.jobs.some((j) => j.status === 'queued' || j.status === 'running');
