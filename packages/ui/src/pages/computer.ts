import type { BrowserRequester, BrowserSlotStatus, BrowserStatus } from '@agenthub/shared';
import { sendJson } from '../api.js';
import { slotKey, type BrowserFrame, type Store, type UiState } from '../store.js';
import { toast } from '../toast.js';
import { formatElapsed } from '../turns.js';
import { button, el } from './projects.js';

/** The owner's requester id; the preempt route pins `kind` to owner itself. */
const OWNER_ID = 'owner';

/** One slot of the browser pool as the page words it. */
export interface BrowserTile {
  key: string;
  node: string;
  slot: number;
  /** `mini · 1`. */
  label: string;
  /** Who holds the slot, null when it is free. */
  holder: string | null;
  /** How long the holder has had it, `—` when free. */
  since: string;
  expires: string;
  leaseId: string | null;
  /** The owner holds it — Take control has nothing left to take. */
  own: boolean;
  draining: boolean;
  /** The newest frame of *this* lease; a frame from an earlier holder of the slot is not shown. */
  frame: BrowserFrame | null;
}

function who(requester: BrowserRequester): string {
  // The owner's id is just 'owner', and an orchestrator's is `project:<slug>`; printing those beside
  // the kind and the project would stutter.
  const bare = requester.id === requester.kind || requester.id === `project:${requester.project}`;
  const name = bare ? requester.kind : `${requester.kind} ${requester.id}`;
  return requester.project ? `${name} — ${requester.project}` : name;
}

/** The pool's slots; a hub from before the pool sends no `slots`, so its one browser is slot 0. */
function slotsOf(status: BrowserStatus | undefined): BrowserSlotStatus[] {
  if (!status) return [];
  if (status.slots) return status.slots;
  return status.node ? [{ node: status.node, slot: 0, lease: status.holder }] : [];
}

/**
 * The pool as tiles, one per slot, in the hub's order. Pure, so the wording is testable without a
 * DOM: the page below is just these tiles painted.
 */
export function browserTiles(status: BrowserStatus | undefined, frames: Record<string, BrowserFrame>, now: number): BrowserTile[] {
  return slotsOf(status).map(({ node, slot, lease, draining }) => {
    const key = slotKey(node, slot);
    const frame = frames[key];
    return {
      key, node, slot,
      label: `${node} · ${slot}`,
      holder: lease ? who(lease.requester) : null,
      since: lease?.since ? formatElapsed(now - lease.since) : '—',
      expires: lease ? `${Math.max(0, Math.round((lease.expiresAt - now) / 1000))}s` : '—',
      leaseId: lease?.leaseId ?? null,
      own: lease?.requester.kind === 'owner',
      draining: draining === true,
      frame: lease && frame?.leaseId === lease.leaseId ? frame : null,
    };
  });
}

/** Who is waiting for a slot, in the order the hub will grant them. */
export function queueView(status: BrowserStatus | undefined): string[] {
  return (status?.queue ?? []).map(who);
}

/** The slot to show large: the one asked for while it exists, else the first held, else the first. */
export function watchedTile(tiles: BrowserTile[], asked: string | null): BrowserTile | null {
  return tiles.find((t) => t.key === asked) ?? tiles.find((t) => t.leaseId) ?? tiles[0] ?? null;
}

interface TileView {
  root: HTMLElement;
  thumb: HTMLImageElement;
  blank: HTMLElement;
  holder: HTMLElement;
  meta: HTMLElement;
  watch: HTMLButtonElement;
  take: HTMLButtonElement;
  release: HTMLButtonElement;
  /** Timestamp of the newest frame decoded, so a late arrival can't overwrite a newer one. */
  shownAt: number;
}

/**
 * The browser pool: the watched slot large on the left with its facts and the queue on the right,
 * and below it a tile per slot with a live thumbnail and Watch / Take control / Release. The page is
 * the only subscriber to the `browser` WS topic — the store drops the frames on leaving, so a stale
 * still can't read as live.
 */
export function mountComputer(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'computer');

  const stage = el('section', 'screen');
  const frame = el('img', 'screen__frame');
  frame.alt = 'Watched browser session';
  frame.hidden = true;
  const blank = el('p', 'empty', 'Waiting for a frame…');
  stage.append(frame, blank);

  const desk = el('section', 'desk');
  const title = el('h2', undefined, 'Browser');
  const facts = el('dl', 'facts');
  const queue = el('p', 'desk__queue');
  desk.append(title, facts, el('h3', undefined, 'Queue'), queue);

  const grid = el('div', 'btiles');
  page.append(stage, desk, grid);
  host.appendChild(page);

  let busy = false;
  let asked: string | null = null;
  let stageAt = 0;
  let stageKey: string | null = null;
  const views = new Map<string, TileView>();

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

  const tileView = (tile: BrowserTile): TileView => {
    const root = el('article', 'btile');
    const shot = el('div', 'btile__thumb');
    const thumb = el('img');
    thumb.alt = `${tile.label} screencast`;
    thumb.hidden = true;
    const blankThumb = el('span', undefined, 'Free');
    shot.append(thumb, blankThumb);
    const head = el('div', 'btile__head');
    head.append(el('strong', undefined, tile.label));
    const holder = el('span', 'btile__holder');
    const meta = el('div', 'btile__meta');
    const actions = el('div', 'btile__actions');
    const watch = button('Watch', 'btn btn--small');
    const take = button('Take control', 'btn btn--small');
    const release = button('Release', 'btn btn--small');
    actions.append(watch, take, release);
    root.append(shot, head, holder, meta, actions);

    const { node, slot } = tile;
    watch.addEventListener('click', () => { asked = tile.key; render(store.getState()); });
    take.addEventListener('click', () => {
      asked = tile.key;
      send(() => sendJson('/api/browser/preempt', { id: OWNER_ID, node, slot }));
    });
    release.addEventListener('click', () => {
      const leaseId = release.dataset.lease;
      if (leaseId) send(() => sendJson(`/api/browser/lease/${leaseId}`, undefined, 'DELETE'));
    });
    return { root, thumb, blank: blankThumb, holder, meta, watch, take, release, shownAt: 0 };
  };

  const paintTile = (view: TileView, tile: BrowserTile, watched: boolean): void => {
    view.root.classList.toggle('btile--free', !tile.leaseId);
    view.root.classList.toggle('is-watched', watched);
    view.holder.textContent = tile.holder ?? (tile.draining ? 'Draining' : 'Free');
    view.meta.textContent = tile.leaseId ? `for ${tile.since} · lease ${tile.expires}` : '';
    view.watch.disabled = watched;
    view.take.disabled = busy || tile.own;
    view.release.hidden = !tile.leaseId;
    view.release.disabled = busy;
    if (tile.leaseId) view.release.dataset.lease = tile.leaseId; else delete view.release.dataset.lease;
    // Decoded once on arrival rather than on paint, so the <img> only ever swaps to a picture the
    // browser already holds.
    if (!tile.frame) {
      view.thumb.hidden = true;
      view.blank.hidden = false;
      view.blank.textContent = tile.leaseId ? 'Waiting for a frame…' : 'Free';
      view.shownAt = 0;
    } else if (tile.frame.at > view.shownAt) {
      view.shownAt = tile.frame.at;
      view.thumb.src = `data:image/jpeg;base64,${tile.frame.jpegBase64}`;
      view.thumb.hidden = false;
      view.blank.hidden = true;
    }
  };

  const paintStage = (tile: BrowserTile | null): void => {
    if (tile?.key !== stageKey) { stageKey = tile?.key ?? null; stageAt = 0; }
    if (!tile) {
      frame.hidden = true;
      blank.hidden = false;
      blank.textContent = 'No node online — nothing is running the shared browser.';
      return;
    }
    if (!tile.frame) {
      frame.hidden = true;
      blank.hidden = false;
      blank.textContent = tile.leaseId ? 'Waiting for a frame…' : `${tile.label} is free.`;
      stageAt = 0;
      return;
    }
    if (tile.frame.at <= stageAt) return;
    stageAt = tile.frame.at;
    frame.src = `data:image/jpeg;base64,${tile.frame.jpegBase64}`;
    frame.hidden = false;
    blank.hidden = true;
  };

  const render = (state: UiState): void => {
    const status = state.hub?.browser;
    const tiles = browserTiles(status, state.browserFrames, Date.now());
    const watched = watchedTile(tiles, asked);

    for (const [key, view] of views) {
      if (!tiles.some((t) => t.key === key)) { view.root.remove(); views.delete(key); }
    }
    for (const tile of tiles) {
      let view = views.get(tile.key);
      if (!view) { view = tileView(tile); views.set(tile.key, view); }
      grid.appendChild(view.root); // re-appending keeps the hub's order
      paintTile(view, tile, tile.key === watched?.key);
    }

    title.textContent = watched ? watched.label : 'Browser';
    facts.replaceChildren();
    const rows: [string, string][] = watched
      ? [['Holder', watched.holder ?? 'free'], ['Since', watched.since], ['Lease ends', watched.expires]]
      : [['Node', 'none online']];
    for (const [label, value] of rows) facts.append(el('dt', undefined, label), el('dd', undefined, value));
    const waiting = queueView(status);
    queue.textContent = waiting.length ? waiting.join(', ') : 'Nobody waiting.';
    paintStage(watched);
  };

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
