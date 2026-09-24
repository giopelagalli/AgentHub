import { describe, it, expect } from 'vitest';
import type { PreviewStatus } from '@agenthub/shared';
import { previewSummary } from '../src/artifacts.js';
import { previewPhase, previewSrc, previewStatusText } from '../src/views/preview.js';

const CAP = 'a'.repeat(32);

const status = (over: Partial<PreviewStatus> = {}): PreviewStatus => ({
  configured: true,
  running: false,
  port: 5173,
  base: `/p/demo/${CAP}/`,
  url: `http://hub.local:4010/p/demo/${CAP}/`,
  startedAt: null,
  config: { cmd: ['npm', 'run', 'dev'], port: 5173, cap: CAP },
  crashed: false,
  log: [],
  ...over,
});

describe('previewPhase', () => {
  it('reads the four states a preview can be in', () => {
    expect(previewPhase(null)).toBe('unconfigured');
    expect(previewPhase(status({ configured: false }))).toBe('unconfigured');
    expect(previewPhase(status({ running: true }))).toBe('running');
    expect(previewPhase(status())).toBe('stopped');
    expect(previewPhase(status({ crashed: true }))).toBe('crashed');
  });

  it('calls a running preview running even if the last one crashed', () => {
    expect(previewPhase(status({ running: true, crashed: true }))).toBe('running');
  });
});

describe('previewStatusText', () => {
  it('names the port while it is up, and the state while it is not', () => {
    expect(previewStatusText(status({ running: true }))).toBe('Running on :5173');
    expect(previewStatusText(status())).toBe('Stopped');
    expect(previewStatusText(status({ crashed: true }))).toBe('Crashed');
    expect(previewStatusText(null)).toBe('Not configured');
  });
});

describe('previewSrc', () => {
  it('opens at the app\'s root by default, and at the configured path otherwise', () => {
    expect(previewSrc(status())).toBe(`http://hub.local:4010/p/demo/${CAP}/`);
    expect(previewSrc(status({ config: { cmd: ['npm'], port: 5173, path: '/dashboard', cap: CAP } })))
      .toBe(`http://hub.local:4010/p/demo/${CAP}/dashboard`);
  });

  it('has nowhere to point until the preview is configured', () => {
    expect(previewSrc(status({ configured: false, url: null }))).toBeNull();
  });
});

describe('previewSummary', () => {
  it('says so while it is being read, and when it could not be', () => {
    expect(previewSummary('loading', null).hint).toBe('Loading…');
    expect(previewSummary('failed', null).hint).toBe('Could not be read');
  });

  it('points at the empty state when the project declares no preview', () => {
    expect(previewSummary('ready', status({ configured: false })).hint).toBe('Not configured');
    expect(previewSummary('ready', null).filled).toBe(false);
  });

  it('shows the port while it is running, and why it is not when it is not', () => {
    expect(previewSummary('ready', status({ running: true })).hint).toBe('Running on :5173');
    expect(previewSummary('ready', status({ running: true })).filled).toBe(true);
    expect(previewSummary('ready', status()).hint).toBe('Stopped');
    expect(previewSummary('ready', status({ crashed: true })).hint).toBe('Crashed — read the log');
  });

  it('is labelled and captioned whatever the state', () => {
    expect(previewSummary('ready', null).label).toBe('Preview');
    expect(previewSummary('ready', null).id).toBe('preview');
    expect(previewSummary('ready', null).caption).toBe('The app, live');
  });
});
