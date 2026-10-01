import { describe, it, expect } from 'vitest';
import type { BrowserLease, BrowserRequester, BrowserStatus, HubState } from '@agenthub/shared';
import type { BrowserFrame } from '../src/store.js';
import { browserStatusText, ordinal, projectBrowserView } from '../src/views/browser.js';

const NOW = 1_000_000;

const agent = (project: string, kind: BrowserRequester['kind'] = 'orchestrator', id = `project:${project}`): BrowserRequester =>
  ({ kind, id, project });

const lease = (slot: number, requester: BrowserRequester, leaseId = `l${slot}`): BrowserLease =>
  ({ leaseId, requester, expiresAt: NOW + 60_000, node: 'mini', slot, since: NOW - 90_000 });

function state(browser: Partial<BrowserStatus>, frames: Record<string, BrowserFrame> = {}): { hub: HubState; browserFrames: Record<string, BrowserFrame> } {
  const slots = [0, 1, 2].map((slot) => ({ node: 'mini', slot, lease: null }));
  return {
    hub: { nodes: [], agents: [], jobs: [], streams: {}, browser: { holder: null, queue: [], node: 'mini', slots, ...browser } },
    browserFrames: frames,
  };
}

describe('projectBrowserView', () => {
  it("shows the project's slot, who drives it, since when, and only this lease's frame", () => {
    const frame: BrowserFrame = { nodeName: 'mini', slot: 1, leaseId: 'l1', jpegBase64: 'abc', at: 5 };
    const slots = [
      { node: 'mini', slot: 0, lease: lease(0, agent('other')) },
      { node: 'mini', slot: 1, lease: lease(1, agent('acme', 'subagent', '7')) },
    ];
    const view = projectBrowserView(state({ slots }, { 'mini#1': frame }), 'acme', NOW);
    expect(view).toMatchObject({ kind: 'held', agent: 'subagent 7', since: NOW - 90_000 });
    if (view.kind !== 'held') throw new Error('not held');
    expect(view.tile).toMatchObject({ label: 'mini · 1', leaseId: 'l1', own: false });
    expect(view.tile.frame?.jpegBase64).toBe('abc');
    expect(browserStatusText(view)).toBe('Live · mini · 1');
  });

  it("keeps showing the slot once the owner has taken control for the project, as 'you'", () => {
    const slots = [{ node: 'mini', slot: 2, lease: lease(2, { kind: 'owner', id: 'owner', project: 'acme' }) }];
    expect(projectBrowserView(state({ slots }), 'acme', NOW)).toMatchObject({ kind: 'held', agent: 'you', tile: { own: true } });
  });

  it("prefers an agent's slot over the owner's when the project shows in both", () => {
    const slots = [
      { node: 'mini', slot: 0, lease: lease(0, { kind: 'owner', id: 'owner', project: 'acme' }) },
      { node: 'mini', slot: 1, lease: lease(1, agent('acme')) },
    ];
    expect(projectBrowserView(state({ slots }), 'acme', NOW)).toMatchObject({ kind: 'held', agent: 'orchestrator', tile: { slot: 1 } });
  });

  it("does not count the owner's slot taken for no project", () => {
    const slots = [{ node: 'mini', slot: 0, lease: lease(0, { kind: 'owner', id: 'owner' }) }];
    expect(projectBrowserView(state({ slots }), 'acme', NOW)).toEqual({ kind: 'none', slots: 1, free: 0 });
  });

  it("gives the project's place in the queue when every slot is busy", () => {
    const slots = [0, 1, 2].map((slot) => ({ node: 'mini', slot, lease: lease(slot, agent(`p${slot}`)) }));
    const queue = [agent('first'), { kind: 'owner' as const, id: 'owner', project: 'acme' }, agent('acme', 'subagent', '9')];
    const view = projectBrowserView(state({ slots, queue }), 'acme', NOW);
    expect(view).toEqual({ kind: 'queued', position: 3, slots: 3 });
    expect(browserStatusText(view)).toBe('Waiting · 3rd in line');
  });

  it('is empty otherwise, counting the free slots — draining and offline ones are not free', () => {
    expect(projectBrowserView(state({}), 'acme', NOW)).toEqual({ kind: 'none', slots: 3, free: 3 });
    const slots = [
      { node: 'mini', slot: 0, lease: null, draining: true },
      { node: 'mini', slot: 1, lease: lease(1, agent('other')), offline: true },
      { node: 'mini', slot: 2, lease: null },
    ];
    expect(projectBrowserView(state({ slots }), 'acme', NOW)).toEqual({ kind: 'none', slots: 3, free: 1 });
    expect(projectBrowserView({ hub: null, browserFrames: {} }, 'acme', NOW)).toEqual({ kind: 'none', slots: 0, free: 0 });
    expect(browserStatusText({ kind: 'none', slots: 0, free: 0 })).toBe('No browser');
  });
});

describe('ordinal', () => {
  it('says 1st, 2nd, 3rd, 4th, and the teens with th', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });
});
