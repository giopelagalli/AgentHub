import { describe, expect, it } from 'vitest';
import type { MediaAsset, MediaList } from '@agenthub/shared';
import { assetCaption, blockedReason, hasJobsInFlight, jobLine, mediaRequest, mediaUrl, SIZE_PRESETS } from '../src/media.js';

const ASSET: MediaAsset = {
  id: 'image-3', file: 'image-3.png', kind: 'image', prompt: 'an icon', params: { width: 1024, height: 1024, seed: 42 },
  jobId: 3, node: 'pc', durationMs: 38_200, createdAt: 1, bytes: 10,
};

const list = (over: Partial<MediaList> = {}): MediaList => ({ assets: [], jobs: [], renderers: { image: true, video: false }, ...over });

describe('media helpers', () => {
  it('keeps every preset on the 16-pixel grid the templates want', () => {
    for (const p of [...SIZE_PRESETS.image, ...SIZE_PRESETS.video]) {
      expect(p.width % 16, p.label).toBe(0);
      expect(p.height % 16, p.label).toBe(0);
    }
  });

  it('builds the request from the box: a preset size, and seconds only for video', () => {
    expect(mediaRequest('image', '  a cat ', 'landscape', 8)).toEqual({ kind: 'image', prompt: 'a cat', width: 1344, height: 768 });
    expect(mediaRequest('video', 'waves', 'portrait', 8)).toEqual({ kind: 'video', prompt: 'waves', width: 480, height: 832, seconds: 8 });
    expect(mediaRequest('image', 'x', 'nope', 5)).toMatchObject({ width: 1024, height: 1024 });
  });

  it('captions an asset with its size, seed and how long it took where', () => {
    expect(assetCaption(ASSET)).toBe('1024×1024 · seed 42 · 38 s on pc');
    expect(assetCaption({ ...ASSET, kind: 'video', durationMs: 300_000, params: { width: 832, height: 480, seconds: 5, fps: 16 } }))
      .toBe('832×480 · 5 s at 16 fps · 5 min on pc');
  });

  it('says what a job is doing', () => {
    const job = { jobId: 1, kind: 'image' as const, prompt: 'x', createdAt: 1 };
    expect(jobLine({ ...job, status: 'queued' })).toBe('Waiting for the GPU machine…');
    expect(jobLine({ ...job, status: 'running' })).toBe('Rendering…');
    expect(jobLine({ ...job, status: 'failed', error: 'comfy job failed' })).toBe('Failed: comfy job failed');
  });

  it('blocks a kind no machine renders, pointing at Help', () => {
    expect(blockedReason(list(), 'image')).toBeNull();
    expect(blockedReason(list(), 'video')).toBe('No machine can render video yet — see Help → Media.');
    expect(blockedReason(list({ renderers: { image: false, video: false } }), 'image')).toMatch(/^No machine can render images yet/);
    expect(blockedReason(null, 'image')).toBeNull();
  });

  it('polls fast only while something is on its way', () => {
    expect(hasJobsInFlight(list())).toBe(false);
    expect(hasJobsInFlight(list({ jobs: [{ jobId: 1, kind: 'image', prompt: 'x', status: 'failed', createdAt: 1 }] }))).toBe(false);
    expect(hasJobsInFlight(list({ jobs: [{ jobId: 1, kind: 'image', prompt: 'x', status: 'running', createdAt: 1 }] }))).toBe(true);
  });

  it('escapes the slug and file into the URL', () => {
    expect(mediaUrl('app', 'image-3.png')).toBe('/api/projects/app/media/image-3.png');
  });
});
