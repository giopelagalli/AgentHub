import type { BrowserStatus } from '@agenthub/shared';
import { button, el } from '../dom.js';
import { browserTiles, releaseLease, requesterName, takeControl, type BrowserTile } from '../pages/computer.js';
import { slotKey, type Store, type UiState } from '../store.js';
import { toast } from '../toast.js';
import type { ViewContext } from './parts.js';

/**
 * What a project's Browser view shows (FR-B7): the slot the project holds, its place in the queue
 * when every slot is busy, or nothing at all.
 */
export type ProjectBrowserView =
  | {
    kind: 'held';
    /** The slot as the Machines page words it — label, frame, lease. */
    tile: BrowserTile;
    /** Who in the project drives it; `you` once the owner has taken control. */
    agent: string;
    /** When the lease was granted; null from a hub that doesn't say. */
    since: number | null;
  }
  | { kind: 'queued'; position: number; slots: number }
  | { kind: 'none'; slots: number; free: number };

/**
 * The project's slot, its place in the queue, or neither. A slot is the project's while its lease
 * names the project — an agent's, or the owner's after Take control from here or from Machines. If
 * the owner holds one slot and an agent another, the agent's is the one shown: it is the live work.
 */
export function projectBrowserView(state: Pick<UiState, 'hub' | 'browserFrames'>, slug: string, now = Date.now()): ProjectBrowserView {
  const status: BrowserStatus | undefined = state.hub?.browser;
  const tiles = browserTiles(status, state.browserFrames, now);
  const leases = (status?.slots ?? []).flatMap((s) => (s.lease?.requester.project === slug ? [s.lease] : []));
  const lease = leases.find((l) => l.requester.kind !== 'owner') ?? leases[0];
  const tile = lease && tiles.find((t) => t.key === slotKey(lease.node, lease.slot));
  if (lease && tile) {
    const agent = lease.requester.kind === 'owner' ? 'you' : requesterName(lease.requester);
    return { kind: 'held', tile, agent, since: lease.since || null };
  }
  const at = (status?.queue ?? []).findIndex((r) => r.project === slug && r.kind !== 'owner');
  if (at >= 0) return { kind: 'queued', position: at + 1, slots: tiles.length };
  return { kind: 'none', slots: tiles.length, free: tiles.filter((t) => !t.leaseId && !t.draining && !t.offline).length };
}

/** `1st`, `2nd`, `3rd`, `11th`, `22nd`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const browsers = (n: number): string => `${n} browser${n === 1 ? '' : 's'}`;

/** The view's status line, beside its dot. */
export function browserStatusText(view: ProjectBrowserView): string {
  if (view.kind === 'held') return `Live · ${view.tile.label}`;
  if (view.kind === 'queued') return `Waiting · ${ordinal(view.position)} in line`;
  return 'No browser';
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The project's live browser, in the Code tab: the screencast large, who drives it, and the owner's
 * Take control / Release — the same calls the Machines tiles make. While it is on screen the page
 * watches the cast (`project-browser`), and stops when it goes.
 */
export function mountProjectBrowser(host: HTMLElement, ctx: ViewContext, store: Store): () => void {
  const root = el('div', 'pbrowser');
  const bar = el('div', 'pbrowser__bar');
  const status = el('span', 'pbrowser__status');
  const dot = el('span', 'dot');
  const statusText = el('span');
  status.append(dot, statusText);
  const take = button('Take control', 'btn btn--small');
  const release = button('Release', 'btn btn--small');
  bar.append(status, take, release);

  const stage = el('div', 'pbrowser__stage');
  const shot = el('figure', 'pbrowser__shot');
  const frame = el('img', 'pbrowser__frame');
  frame.alt = `${ctx.title}'s browser`;
  const wait = el('p', 'pbrowser__wait', 'Waiting for a frame…');
  const screen = el('div', 'pbrowser__screen');
  screen.append(frame, wait);
  const caption = el('figcaption', 'pbrowser__caption');
  const where = el('strong');
  const holder = el('span');
  caption.append(where, holder);
  shot.append(screen, caption);

  const empty = el('div', 'pbrowser__empty');
  const emptyTitle = el('p', 'pbrowser__title');
  const emptyLine = el('p', 'pbrowser__line');
  empty.append(emptyTitle, emptyLine);
  stage.append(shot, empty);

  if (ctx.actions) {
    ctx.actions.replaceChildren(bar);
    root.append(stage);
  } else root.append(bar, stage);
  host.appendChild(root);

  let busy = false;
  let current: ProjectBrowserView = { kind: 'none', slots: 0, free: 0 };
  /** The newest frame on screen and its lease, so a late arrival can't overwrite a newer one. */
  let shownAt = 0;
  let shownLease: string | null = null;

  const send = (request: () => Promise<unknown>): void => {
    busy = true;
    render(store.getState());
    void request()
      .catch((error: unknown) => toast(String(error), 'error'))
      .finally(() => { busy = false; render(store.getState()); });
  };
  take.addEventListener('click', () => {
    if (current.kind === 'held') {
      const { node, slot } = current.tile;
      send(() => takeControl(node, slot, ctx.slug));
    }
  });
  release.addEventListener('click', () => {
    const leaseId = current.kind === 'held' ? current.tile.leaseId : null;
    if (leaseId) send(() => releaseLease(leaseId));
  });

  function render(state: UiState): void {
    const view = projectBrowserView(state, ctx.slug);
    current = view;
    const held = view.kind === 'held';
    statusText.textContent = browserStatusText(view);
    dot.className = `dot${held ? ' dot--active dot--pulse' : view.kind === 'queued' ? ' dot--paused' : ''}`;
    take.hidden = !held;
    release.hidden = !held;
    shot.hidden = !held;
    empty.hidden = held;

    if (view.kind !== 'held') {
      shownAt = 0;
      shownLease = null;
      frame.removeAttribute('src');
      if (view.kind === 'queued') {
        emptyTitle.textContent = 'Waiting for a browser.';
        emptyLine.textContent = `${ordinal(view.position)} in line — all ${browsers(view.slots)} are in use.`;
      } else {
        emptyTitle.textContent = 'No browser in use.';
        emptyLine.textContent = view.slots === 0
          ? 'Agents open one when a task needs the web. No machine offers a browser right now.'
          : view.free === 0
            ? `Agents open one when a task needs the web. All ${browsers(view.slots)} are in use.`
            : 'Agents open one when a task needs the web.';
      }
      return;
    }

    const { tile } = view;
    take.disabled = busy || tile.own;
    take.title = tile.own ? 'You have control' : `Take ${tile.label} over from the ${view.agent}`;
    release.disabled = busy;
    where.textContent = tile.label;
    const since = view.since ? ` since ${clock(view.since)}` : '';
    holder.textContent = `Held by ${view.agent}${since}${tile.offline ? ' · node offline' : ''}`;

    if (tile.leaseId !== shownLease) { shownLease = tile.leaseId; shownAt = 0; }
    if (!tile.frame) {
      if (shownAt === 0) { frame.hidden = true; wait.hidden = false; }
    } else if (tile.frame.at > shownAt) {
      shownAt = tile.frame.at;
      frame.src = `data:image/jpeg;base64,${tile.frame.jpegBase64}`;
      frame.hidden = false;
      wait.hidden = true;
    }
  }

  const unsubscribe = store.subscribe(render);
  store.dispatch({ type: 'project-browser', open: true });
  render(store.getState());

  return () => {
    unsubscribe();
    store.dispatch({ type: 'project-browser', open: false });
    root.remove();
  };
}
