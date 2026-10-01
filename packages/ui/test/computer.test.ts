import { describe, it, expect } from 'vitest';
import type { BrowserLease, BrowserStatus } from '@agenthub/shared';
import { browserTiles, queueView, watchedTile } from '../src/pages/computer.js';
import type { BrowserFrame } from '../src/store.js';

const NOW = 1_000_000;

const lease = (over: Partial<BrowserLease> = {}): BrowserLease => ({
  leaseId: 'l1', requester: { kind: 'subagent', id: '7', project: 'acme' },
  expiresAt: NOW + 41_600, node: 'mini', slot: 0, since: NOW - 125_000, ...over,
});

function status(over: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    holder: null, queue: [], node: 'mini',
    slots: [{ node: 'mini', slot: 0, lease: null }, { node: 'mini', slot: 1, lease: null }],
    ...over,
  };
}

const frame = (over: Partial<BrowserFrame> = {}): BrowserFrame =>
  ({ nodeName: 'mini', slot: 0, leaseId: 'l1', jpegBase64: 'abc', at: 5, ...over });

describe('browserTiles', () => {
  it('has a quiet tile per free slot', () => {
    expect(browserTiles(status(), {}, NOW)).toEqual([0, 1].map((slot) => ({
      key: `mini#${slot}`, node: 'mini', slot, label: `mini · ${slot}`,
      holder: null, since: '—', expires: '—', leaseId: null, own: false, draining: false, offline: false, frame: null,
    })));
  });

  it('has no tiles when the hub has never sent browser status, or has no browser node', () => {
    expect(browserTiles(undefined, {}, NOW)).toEqual([]);
    expect(browserTiles(status({ node: null, slots: [] }), {}, NOW)).toEqual([]);
  });

  it('names the holder, its project, how long it has held the slot and the seconds left', () => {
    const [tile] = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: lease() }] }), {}, NOW);
    expect(tile).toMatchObject({ holder: 'subagent 7 — acme', since: '2m05s', expires: '42s', leaseId: 'l1', own: false });
    const orch = lease({ requester: { kind: 'orchestrator', id: 'project:acme', project: 'acme' } });
    expect(browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: orch }] }), {}, NOW)[0].holder).toBe('orchestrator — acme');
  });

  it('never shows a negative countdown, and marks the owner without stuttering its name', () => {
    const owned = lease({ requester: { kind: 'owner', id: 'owner' }, expiresAt: NOW - 5_000 });
    const [tile] = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: owned }] }), {}, NOW);
    expect(tile).toMatchObject({ holder: 'owner', expires: '0s', own: true });
  });

  it("shows a slot's frame only while it belongs to the current lease", () => {
    const slots = [{ node: 'mini', slot: 0, lease: lease() }, { node: 'mini', slot: 1, lease: null }];
    const frames = { 'mini#0': frame(), 'mini#1': frame({ slot: 1, leaseId: 'gone' }) };
    const [held, free] = browserTiles(status({ slots }), frames, NOW);
    expect(held.frame?.jpegBase64).toBe('abc');
    expect(free.frame).toBeNull();
    const [stale] = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: lease({ leaseId: 'l2' }) }] }), frames, NOW);
    expect(stale.frame).toBeNull();
  });

  it('marks a draining slot, and a held slot on an offline node', () => {
    const [tile] = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: null, draining: true }] }), {}, NOW);
    expect(tile.draining).toBe(true);
    const [gone] = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: lease(), draining: true, offline: true }] }), {}, NOW);
    expect(gone).toMatchObject({ offline: true, leaseId: 'l1' });
  });

  it('reads a hub from before the pool as one slot 0', () => {
    const tiles = browserTiles({ holder: lease(), queue: [], node: 'mini' }, {}, NOW);
    expect(tiles.map((t) => [t.key, t.leaseId])).toEqual([['mini#0', 'l1']]);
  });
});

describe('watchedTile', () => {
  const tiles = browserTiles(status({ slots: [{ node: 'mini', slot: 0, lease: null }, { node: 'mini', slot: 1, lease: lease({ slot: 1 }) }] }), {}, NOW);

  it('watches what was asked for, else the first held slot, else the first slot', () => {
    expect(watchedTile(tiles, 'mini#0')?.key).toBe('mini#0');
    expect(watchedTile(tiles, null)?.key).toBe('mini#1');
    expect(watchedTile(tiles, 'gone#3')?.key).toBe('mini#1');
    expect(watchedTile(browserTiles(status(), {}, NOW), null)?.key).toBe('mini#0');
    expect(watchedTile([], null)).toBeNull();
  });
});

describe('queueView', () => {
  it('lists the queue in the order the hub reports it', () => {
    const queue = queueView(status({ queue: [{ kind: 'orchestrator', id: '3', project: 'acme' }, { kind: 'subagent', id: '4' }] }));
    expect(queue).toEqual(['orchestrator 3 — acme', 'subagent 4']);
  });
});
