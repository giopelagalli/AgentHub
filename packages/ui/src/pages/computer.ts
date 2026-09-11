import type { BrowserRequester, BrowserStatus } from '@agenthub/shared';
import { sendJson } from '../api.js';
import type { Store, UiState } from '../store.js';
import { toast } from '../toast.js';
import { button, el } from './projects.js';

/** The owner's requester id; the preempt route pins `kind` to owner itself. */
const OWNER_ID = 'owner';

export interface BrowserView {
  node: string;
  holder: string;
  expires: string;
  queue: string[];
  /** The lease the owner may release; null unless the owner is the holder. */
  ownLeaseId: string | null;
}

function who(requester: BrowserRequester): string {
  // The owner's id is just 'owner'; printing kind and id both would stutter.
  const name = requester.id === requester.kind ? requester.kind : `${requester.kind} ${requester.id}`;
  return requester.project ? `${name} — ${requester.project}` : name;
}

/**
 * Lease status as the page words it. Pure, so the wording is testable without a
 * DOM: the page below is just this view painted into the lease panel.
 */
export function browserView(status: BrowserStatus | undefined, now: number): BrowserView {
  const holder = status?.holder ?? null;
  const owned = holder?.requester.kind === 'owner';
  return {
    node: status?.node ?? 'none online',
    holder: holder ? who(holder.requester) : 'free',
    expires: holder ? `${Math.max(0, Math.round((holder.expiresAt - now) / 1000))}s` : '—',
    queue: (status?.queue ?? []).map(who),
    ownLeaseId: owned ? holder.leaseId : null,
  };
}

/**
 * The shared browser: the live screencast on the left, the lease desk on the
 * right. The page is the only subscriber to the `browser` WS topic — the store
 * drops the last frame on leaving, so a stale still can't read as live.
 */
export function mountComputer(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'computer');

  const stage = el('section', 'screen');
  const frame = el('img', 'screen__frame');
  frame.alt = 'Shared browser screencast';
  frame.hidden = true;
  const blank = el('p', 'empty', 'Waiting for a frame…');
  stage.append(frame, blank);

  const desk = el('section', 'desk');
  const facts = el('dl', 'facts');
  const queueHeading = el('h3', undefined, 'Queue');
  const queue = el('p', 'desk__queue');
  const actions = el('div', 'actions');
  const take = button('Take control', 'btn btn--primary');
  const release = button('Release');
  actions.append(take, release);
  desk.append(el('h2', undefined, 'Shared browser'), facts, actions, queueHeading, queue);

  page.append(stage, desk);
  host.appendChild(page);

  let busy = false;
  let ownLeaseId: string | null = null;
  /** Timestamp of the newest frame decoded, so a late arrival can't overwrite a newer one. */
  let shownAt = 0;

  const render = (state: UiState): void => {
    const view = browserView(state.hub?.browser, Date.now());
    ownLeaseId = view.ownLeaseId;
    const online = Boolean(state.hub?.browser?.node);

    facts.replaceChildren();
    for (const [label, value] of [['Node', view.node], ['Holder', view.holder], ['Lease ends', view.expires]]) {
      facts.append(el('dt', undefined, label), el('dd', undefined, value));
    }

    queue.textContent = view.queue.length ? view.queue.join(', ') : 'Nobody waiting.';
    take.disabled = busy || !online || view.ownLeaseId !== null;
    release.disabled = busy || view.ownLeaseId === null;

    if (!online) {
      frame.hidden = true;
      blank.hidden = false;
      blank.textContent = 'No node online — nothing is running the shared browser.';
      return;
    }
    blank.textContent = 'Waiting for a frame…';
  };

  /** Runs one lease call; the hub broadcasts the new status, which re-renders us. */
  const send = (request: () => Promise<unknown>): void => {
    busy = true;
    render(store.getState());
    void request()
      .catch((error: unknown) => toast(String(error), 'error'))
      .finally(() => {
        busy = false;
        render(store.getState());
      });
  };

  take.addEventListener('click', () => send(() => sendJson('/api/browser/preempt', { id: OWNER_ID })));
  release.addEventListener('click', () => {
    const leaseId = ownLeaseId;
    if (leaseId) send(() => sendJson(`/api/browser/lease/${leaseId}`, undefined, 'DELETE'));
  });

  // Decoded once on arrival rather than on paint, so the <img> only ever swaps
  // to a picture the browser already holds.
  const onFrame = (state: UiState): void => {
    const next = state.browserFrame;
    if (!next || !state.hub?.browser?.node) {
      frame.hidden = true;
      blank.hidden = false;
      shownAt = 0;
      return;
    }
    if (next.at <= shownAt) return;
    shownAt = next.at;
    frame.src = `data:image/jpeg;base64,${next.jpegBase64}`;
    frame.hidden = false;
    blank.hidden = true;
  };

  const unsubscribe = store.subscribe((state) => { render(state); onFrame(state); });
  render(store.getState());
  onFrame(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
