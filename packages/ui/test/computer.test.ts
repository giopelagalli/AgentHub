import { describe, it, expect } from 'vitest';
import type { BrowserStatus } from '@agenthub/shared';
import { browserView } from '../src/pages/computer.js';

const NOW = 100_000;

function status(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return { holder: null, queue: [], node: 'macmini', ...overrides };
}

describe('browserView', () => {
  it('reads free when nobody holds the lease', () => {
    expect(browserView(status(), NOW)).toEqual({
      node: 'macmini',
      holder: 'free',
      expires: '—',
      queue: [],
      ownLeaseId: null,
    });
  });

  it('says so when the hub has never sent browser status, or has no browser node', () => {
    expect(browserView(undefined, NOW).node).toBe('none online');
    expect(browserView(status({ node: null }), NOW).node).toBe('none online');
  });

  it('names the holder, its project, and the seconds left on the lease', () => {
    const view = browserView(
      status({
        holder: {
          leaseId: 'l1',
          requester: { kind: 'subagent', id: '7', project: 'acme' },
          expiresAt: NOW + 41_600,
        },
      }),
      NOW,
    );
    expect(view.holder).toBe('subagent 7 — acme');
    expect(view.expires).toBe('42s');
    // Not the owner's lease, so there is nothing for the owner to release.
    expect(view.ownLeaseId).toBeNull();
  });

  it('never shows a negative countdown for a lease the sweep has not collected yet', () => {
    const holder = { leaseId: 'l1', requester: { kind: 'owner' as const, id: 'owner' }, expiresAt: NOW - 5_000 };
    expect(browserView(status({ holder }), NOW).expires).toBe('0s');
  });

  it('offers the owner its own lease to release, without stuttering its name', () => {
    const holder = { leaseId: 'l9', requester: { kind: 'owner' as const, id: 'owner' }, expiresAt: NOW };
    const view = browserView(status({ holder }), NOW);
    expect(view.ownLeaseId).toBe('l9');
    expect(view.holder).toBe('owner');
  });

  it('lists the queue in the order the hub reports it', () => {
    const view = browserView(
      status({
        queue: [
          { kind: 'orchestrator', id: '3', project: 'acme' },
          { kind: 'subagent', id: '4' },
        ],
      }),
      NOW,
    );
    expect(view.queue).toEqual(['orchestrator 3 — acme', 'subagent 4']);
  });
});
