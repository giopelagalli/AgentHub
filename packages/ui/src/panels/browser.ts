import type { BrowserRequester, BrowserStatus } from '@agenthub/shared';
import type { Store, UiState } from '../store.js';

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
 * Lease status as the panel words it. Pure, so the wording is testable without a
 * DOM: the panel below is just this view painted into a GB card.
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

function actionButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return button;
}

/**
 * The screening room's lease desk: who holds the browser, who is queued behind
 * them, and the owner's two levers. It follows the store rather than snapshotting
 * it, because the whole point of taking control is watching the badge flip.
 */
export function openBrowserPanel(host: HTMLElement, store: Store): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--center';

  const heading = document.createElement('h2');
  heading.textContent = 'Browser';
  panel.appendChild(heading);

  const facts = document.createElement('dl');
  panel.appendChild(facts);

  const queueHeading = document.createElement('h3');
  queueHeading.textContent = 'Queue';
  panel.appendChild(queueHeading);

  const queue = document.createElement('p');
  panel.appendChild(queue);

  const error = document.createElement('p');
  error.className = 'gb-chat__msg--error';
  error.hidden = true;
  panel.appendChild(error);

  const take = actionButton('Take control');
  const release = actionButton('Release');
  const controls = document.createElement('div');
  controls.className = 'gb-actions';
  controls.append(take, release);
  panel.appendChild(controls);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to close';
  panel.appendChild(hint);

  let busy = false;
  let ownLeaseId: string | null = null;

  const render = (state: UiState): void => {
    const view = browserView(state.hub?.browser, Date.now());
    ownLeaseId = view.ownLeaseId;

    facts.replaceChildren();
    for (const [label, value] of [
      ['Node', view.node],
      ['Holder', view.holder],
      ['Lease ends', view.expires],
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      facts.append(term, detail);
    }

    queue.textContent = view.queue.length ? view.queue.join(', ') : 'Nobody waiting.';
    take.disabled = busy || view.ownLeaseId !== null;
    release.disabled = busy || view.ownLeaseId === null;
  };

  /** Runs one lease call; the hub broadcasts the new status, which re-renders us. */
  const send = async (request: () => Promise<Response>): Promise<void> => {
    busy = true;
    error.hidden = true;
    render(store.getState());
    try {
      const response = await request();
      if (!response.ok) throw new Error(`hub replied ${response.status}`);
    } catch (failure) {
      error.textContent = String(failure);
      error.hidden = false;
    } finally {
      busy = false;
      render(store.getState());
    }
  };

  take.addEventListener('click', () => {
    void send(() => fetch('/api/browser/preempt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: OWNER_ID }),
    }));
  });

  release.addEventListener('click', () => {
    const leaseId = ownLeaseId;
    if (!leaseId) return;
    void send(() => fetch(`/api/browser/lease/${leaseId}`, { method: 'DELETE' }));
  });

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  host.appendChild(panel);
  return () => {
    unsubscribe();
    panel.remove();
  };
}
