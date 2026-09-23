import { el } from '../dom.js';
import { turnsOf, type Store, type UiState } from '../store.js';
import {
  formatDuration, formatElapsed, formatUsd, memberCostUsd, memberFeed, runningTurn, truncate,
  type FeedRow, type TurnRecord,
} from '../turns.js';

/**
 * "Now": the live section at the top of an agent's drawer. Whether they are working and on what,
 * and the rows of the turn as they land — the same events the Activity timeline draws, filtered
 * to this one agent. Fed by the store the socket writes turn events into, so it follows a running
 * turn with no fetch of its own.
 */

/** What the section needs: the store, which project's turns to read, and whose card this is. */
export interface NowDeps {
  store: Store;
  slug: string;
  /** `manager`, or the member id the turn events carry (`coder-1`). */
  who: string;
  /** A muted fact beside the state while idle, e.g. `3 sessions`; omitted where there is none. */
  meta?: string;
}

export interface NowHandle {
  root: HTMLElement;
  /** The one line shown while idle, once the drawer's activity fetch has landed. */
  setLastTurn: (line: string | null) => void;
  dispose: () => void;
}

/** The newest rows worth keeping on screen; the whole turn is the Activity panel's business. */
const VISIBLE = 60;
const TICK_MS = 1000;

/** Within a few pixels of the end, so a reader who scrolled back stays where they are. */
const CLOSE_ENOUGH = 8;

/** What the status line names: the task they are on, else the last thing they did. */
function caption(rows: FeedRow[]): string {
  let closed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === 'task-end') closed++;
    else if (row.kind === 'task-start') {
      if (!closed) return truncate(row.task, 70);
      closed--;
    }
  }
  const last = rows[rows.length - 1];
  if (!last) return '';
  if (last.kind === 'tool') return truncate(last.subject ? `${last.tool} ${last.subject}` : last.tool, 70);
  if (last.kind === 'text') return truncate(last.text, 70);
  return '';
}

export function mountNow(deps: NowDeps): NowHandle {
  const root = el('section', 'now');
  const status = el('p', 'now__status');
  const dot = el('span', 'dot');
  dot.setAttribute('aria-hidden', 'true');
  const state = el('span', 'now__state');
  const doing = el('span', 'now__doing');
  const elapsed = el('span', 'now__elapsed');
  const spend = el('span', 'now__spend');
  status.append(dot, state, doing, spend, elapsed);
  const lastLine = el('p', 'now__last');
  // `tl__rows` is the timeline's hairline-and-gap rhythm; the feed only adds its own scroll.
  const feed = el('div', 'tl__rows now__feed');
  feed.setAttribute('aria-live', 'polite');
  root.append(el('h3', 'now__title', 'Now'), status, lastLine, feed);

  /** True while the newest row should stay in view: the owner has not scrolled up. */
  let following = true;
  let lastTurnLine: string | null = null;
  let held: unknown = null;
  let sig = '';
  let alive = true;

  const atBottom = (): boolean => feed.scrollHeight - feed.scrollTop - feed.clientHeight < CLOSE_ENOUGH;
  feed.addEventListener('scroll', () => { following = atBottom(); });

  const toolNode = (row: Extract<FeedRow, { kind: 'tool' }>): HTMLElement => {
    const pending = row.ok === null;
    const line = el('div', `now__tool tl__tool${row.ok === false ? ' tl__tool--failed' : pending ? ' tl__tool--pending' : ''}`);
    const mark = el('span', 'tl__mark');
    mark.setAttribute('aria-hidden', 'true');
    line.append(mark, el('span', 'tl__toolname', row.tool));
    if (row.subject) line.appendChild(el('span', 'tl__args', row.subject));
    if (row.result) line.appendChild(el('span', 'tl__result', row.result));
    line.appendChild(el('span', 'tl__ms', pending ? '…' : formatDuration(row.ms ?? 0)));
    // The column is narrow enough that a path or a result often ends in an ellipsis; the whole of
    // it is one hover away, and the Activity panel has the rest.
    const full = [row.tool, row.subject, row.result].filter(Boolean).join(' · ');
    line.title = row.ok === false ? `${full} — the tool reported a failure` : full;
    return line;
  };

  const markNode = (verb: string, text: string, tail: string, className = 'now__mark'): HTMLElement => {
    const line = el('p', className);
    line.append(el('span', 'now__markverb', verb));
    if (text) line.appendChild(el('span', 'now__marktext', text));
    if (tail) line.appendChild(el('span', 'tl__ms', tail));
    return line;
  };

  const rowNode = (row: FeedRow): HTMLElement => {
    switch (row.kind) {
      case 'tool': return toolNode(row);
      case 'text': return el('p', 'tl__text now__said', row.text);
      case 'task-start': return markNode('Task', row.task, '');
      case 'task-end': return markNode(row.outcome, '', formatDuration(row.ms), 'now__mark now__mark--end');
    }
  };

  /** The turn this section is about: the one running, else the newest one they did something in. */
  const currentTurn = (turns: TurnRecord[]): TurnRecord | null =>
    runningTurn(turns) ?? turns.find((turn) => memberFeed(turn, deps.who).length) ?? null;

  const render = (uiState: UiState): void => {
    if (!alive) return;
    const turns = turnsOf(uiState, deps.slug);
    if (turns === held && sig) return;
    held = turns;
    const turn = currentTurn(turns.turns);
    const next = `${turn ? `${turn.sessionId}:${turn.events.length}:${turn.endedAt}` : 'none'}|${lastTurnLine ?? ''}`;
    if (next === sig) return;
    sig = next;

    const rows = memberFeed(turn, deps.who);
    const last = rows[rows.length - 1];
    // Their task closing is the clearest sign they are done, even while the turn itself goes on.
    const working = turn !== null && turn.endedAt === null && last !== undefined && last.kind !== 'task-end';

    dot.className = working ? 'dot dot--working' : 'dot';
    state.textContent = working ? 'Working' : 'Idle';
    doing.textContent = working ? caption(rows) : (deps.meta ?? '');
    doing.hidden = !doing.textContent;
    if (working && rows.length) {
      // Since their first row in this turn: how long they have been on it, not how long it has run.
      elapsed.dataset.elapsed = String(rows[0].at);
      elapsed.textContent = formatElapsed(Date.now() - rows[0].at);
    } else {
      delete elapsed.dataset.elapsed;
      elapsed.textContent = '';
    }
    // Their own model calls in this turn, not the turn's total: this card is about them.
    const usd = memberCostUsd(turn, deps.who);
    spend.textContent = usd > 0 ? ` · ${formatUsd(usd)} this turn` : '';
    spend.hidden = !spend.textContent;
    // Two lines of it at drawer width: enough to place the turn, not enough to bury the feed.
    lastLine.textContent = !working && lastTurnLine ? `Last turn: ${truncate(lastTurnLine, 120)}` : '';
    lastLine.hidden = !lastLine.textContent;

    feed.replaceChildren(...rows.slice(-VISIBLE).map(rowNode));
    if (!rows.length) {
      feed.appendChild(el('p', 'now__empty', turn ? 'Nothing from them in this turn yet.' : 'No turns yet.'));
    }
    if (following) feed.scrollTop = feed.scrollHeight;
  };

  const timer = setInterval(() => {
    const at = Number(elapsed.dataset.elapsed);
    if (at) elapsed.textContent = formatElapsed(Date.now() - at);
  }, TICK_MS);

  const unsubscribe = deps.store.subscribe(render);
  render(deps.store.getState());
  // The drawer is put on the page after this mounts, so the first render measures nothing and its
  // pin does nothing. One frame later the feed has a height and the newest row can be brought up.
  requestAnimationFrame(() => { if (alive && following) feed.scrollTop = feed.scrollHeight; });

  return {
    root,
    setLastTurn: (line) => {
      lastTurnLine = line?.trim() ? line.trim() : null;
      sig = '';
      render(deps.store.getState());
    },
    dispose: () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
      root.remove();
    },
  };
}
