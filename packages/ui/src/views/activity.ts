import type { TeamRoster } from '@agenthub/shared';
import { getJson } from '../api.js';
import { avatarSvg } from '../avatars.js';
import { button, el } from '../dom.js';
import { turnsOf, type Store, type UiState } from '../store.js';
import {
  activeWho, doingCaption, formatDuration, formatElapsed, formatTime, formatUsd, runningTurn, timelineModel, truncate, turnDuration, whoView,
  type SubagentBlock, type TimelineGroup, type TimelineItem, type TimelineRow, type TurnRecord, type TurnsResponse,
} from '../turns.js';
import type { ViewContext } from './parts.js';

/** What the view needs beyond the sheet: the store the socket feeds, and the roster for names. */
export interface ActivityDeps {
  store: Store;
  roster: () => TeamRoster | null;
}

const TICK_MS = 1000;

/** A 16px face and a name, the way every row and block names who acted. */
function whoChip(who: string, roster: TeamRoster | null, withRole = false): HTMLElement {
  const view = whoView(who, roster);
  const chip = el('span', 'who');
  const face = el('span', 'who__face');
  if (view.avatar) face.appendChild(avatarSvg(view.avatar, 16));
  else face.textContent = view.name.slice(0, 1).toUpperCase();
  chip.append(face, el('span', 'who__name', view.name));
  if (withRole && view.role) chip.appendChild(el('span', 'who__role', view.role));
  return chip;
}

/** Pass, fail, skipped — and approved or changes — as the small chips verify rows and milestones share. */
function verifyChip(label: string, tone: 'pass' | 'fail' | 'changes' | 'skipped'): HTMLElement {
  return el('span', `verify verify--${tone}`, label);
}

/**
 * The Activity panel: the project's turns on the left, the selected turn's event feed on the
 * right. The feed is rebuilt from the timeline model whenever the turn grows — the model keys
 * every row to its event, so which tool rows the reader opened, and whether they were following
 * the newest row, both survive the rebuild.
 */
export function mountActivity(host: HTMLElement, ctx: ViewContext, deps: ActivityDeps): () => void {
  const { store } = deps;
  const root = el('div', 'activity');
  root.tabIndex = -1;
  const list = el('nav', 'activity__list');
  list.setAttribute('aria-label', 'Turns');
  const feed = el('section', 'activity__feed');
  const feedHead = el('header', 'activity__feedhead');
  const scroller = el('div', 'activity__scroll');
  feed.append(feedHead, scroller);
  root.append(list, feed);
  host.appendChild(root);

  /** The turn on the right; null until there is one. Set by the reader, or followed to the newest. */
  let selectedId: number | null = null;
  let pinnedByReader = false;
  /** Row keys the reader has opened in the selected turn; reset on selecting another. */
  let expanded = new Set<number>();
  /** True while the newest row should stay in view: the reader has not scrolled up. */
  let following = true;

  let lastTurns: unknown = null;
  let lastListSig = '';
  let lastFeedSig = '';
  let alive = true;

  const now = (): number => Date.now();

  const slugTurns = (state: UiState = store.getState()) => turnsOf(state, ctx.slug);

  const atBottom = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;

  /** Picks the turn the reader should be looking at when they have not chosen one. */
  const settleSelection = (): void => {
    const { turns } = slugTurns();
    if (pinnedByReader && turns.some((t) => t.sessionId === selectedId)) return;
    const wanted = runningTurn(turns) ?? turns[0] ?? null;
    const nextId = wanted?.sessionId ?? null;
    if (nextId !== selectedId) {
      selectedId = nextId;
      expanded = new Set();
      following = true;
      pinnedByReader = false;
    }
  };

  const select = (sessionId: number, byReader: boolean): void => {
    if (sessionId !== selectedId) {
      selectedId = sessionId;
      expanded = new Set();
      following = true;
    }
    pinnedByReader = byReader;
    lastFeedSig = '';
    lastListSig = '';
    render(store.getState());
  };

  // --- the list -------------------------------------------------------------------

  const turnItem = (turn: TurnRecord, roster: TeamRoster | null): HTMLButtonElement => {
    const running = turn.endedAt === null;
    const failed = !running && turn.outcome !== null && /fail|error|abort/i.test(turn.outcome);
    const item = button('', `turn${running ? ' turn--running' : ''}`);
    item.dataset.session = String(turn.sessionId);
    if (turn.sessionId === selectedId) item.setAttribute('aria-current', 'true');

    const head = el('span', 'turn__head');
    const dot = el('span', `turn__dot${running ? ' turn__dot--running' : failed ? ' turn__dot--failed' : ''}`);
    dot.setAttribute('aria-hidden', 'true');
    const dur = el('span', 'turn__dur', formatElapsed(turnDuration(turn, now())));
    if (running) dur.dataset.elapsed = String(turn.startedAt);
    head.append(dot, el('span', 'turn__time', formatTime(turn.startedAt)), dur);
    item.appendChild(head);

    const line = running
      ? (() => {
        const who = activeWho(turn);
        const doing = doingCaption(turn, who, 48);
        return doing ? `${whoView(who, roster).name} is ${doing}` : 'Starting…';
      })()
      : (turn.summary ? truncate(turn.summary, 90) : (turn.outcome ?? 'Ended'));
    item.appendChild(el('span', 'turn__line', line));
    const meta = el('span', 'turn__meta');
    meta.append(
      el('span', undefined, running ? 'running' : (turn.outcome ?? 'ended')),
      el('span', undefined, `${turn.toolCalls} tool call${turn.toolCalls === 1 ? '' : 's'}`),
    );
    // Only a turn that actually cost something says so; a free local turn stays uncluttered.
    if (turn.cost.usd > 0) meta.appendChild(el('span', 'turn__cost', formatUsd(turn.cost.usd)));
    item.appendChild(meta);
    item.addEventListener('click', () => select(turn.sessionId, true));
    return item;
  };

  const renderList = (state: UiState): void => {
    const held = slugTurns(state);
    const roster = deps.roster();
    const sig = [held.state, selectedId, ...held.turns.map((t) => `${t.sessionId}:${t.events.length}:${t.endedAt}:${t.cost.usd}`)].join('|');
    if (sig === lastListSig) return;
    lastListSig = sig;

    list.replaceChildren();
    const head = el('div', 'activity__listhead');
    head.append(el('h3', undefined, 'Turns'), el('span', 'activity__count', held.turns.length ? String(held.turns.length) : ''));
    list.appendChild(head);

    if (!held.turns.length) {
      list.appendChild(el(
        'p', held.state === 'failed' ? 'empty empty--error activity__empty' : 'empty activity__empty',
        held.state === 'loading' ? 'Loading turns…'
          : held.state === 'failed' ? 'The hub did not answer for this project’s turns.'
            : 'No turns yet — Run turn starts one.',
      ));
      return;
    }
    for (const turn of held.turns) list.appendChild(turnItem(turn, roster));
  };

  // --- the feed -------------------------------------------------------------------

  const toolRow = (row: Extract<TimelineRow, { kind: 'tool' }>): HTMLElement => {
    const details = el('details', `tl__tool${row.ok === false ? ' tl__tool--failed' : ''}${row.ok === null ? ' tl__tool--pending' : ''}`);
    if (expanded.has(row.key)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(row.key);
      else expanded.delete(row.key);
    });

    const line = el('summary', 'tl__toolline');
    const mark = el('span', 'tl__mark');
    mark.setAttribute('aria-hidden', 'true');
    line.append(mark, el('span', 'tl__toolname', row.tool));
    if (row.args) line.appendChild(el('span', 'tl__args', row.args));
    if (row.summary) line.appendChild(el('span', 'tl__result', row.summary));
    line.appendChild(el('span', 'tl__ms', row.ms === null ? '…' : formatDuration(row.ms)));
    if (row.ok === false) line.title = 'The tool reported a failure';
    details.appendChild(line);

    const body = el('div', 'tl__toolbody');
    if (row.args) body.append(el('span', 'tl__label', 'args'), el('pre', 'tl__pre', row.args));
    body.append(
      el('span', 'tl__label', row.ok === null ? 'result' : row.ok ? 'result · ok' : 'result · failed'),
      el('pre', 'tl__pre', row.summary || (row.ok === null ? 'still running' : '(no summary)')),
    );
    details.appendChild(body);
    return details;
  };

  const rowNode = (row: TimelineRow): HTMLElement => {
    switch (row.kind) {
      case 'start':
        return el('p', 'tl__start', `Turn started ${formatTime(row.at)}`);
      case 'text':
        return el('p', 'tl__text', row.text);
      case 'tool':
        return toolRow(row);
      case 'verify': {
        const box = el('div', 'tl__verify');
        const head = el('div', 'tl__verifyhead');
        head.append(
          el('span', 'tl__verifytitle', 'Verified'),
          el('span', 'tl__verifyid', row.milestoneId),
          verifyChip(`tests ${row.tests}`, row.tests === 'pass' ? 'pass' : row.tests === 'fail' ? 'fail' : 'skipped'),
          verifyChip(`review ${row.review}`, row.review === 'approved' ? 'pass' : row.review === 'changes' ? 'changes' : 'skipped'),
        );
        box.appendChild(head);
        if (row.summary) box.appendChild(el('p', 'tl__verifysummary', row.summary));
        return box;
      }
      case 'end': {
        const box = el('div', 'tl__end');
        const head = el('div', 'tl__endhead');
        head.append(
          el('span', 'tl__endtitle', 'Turn ended'),
          el('span', `pill pill--${/fail|error|abort/i.test(row.outcome) ? 'blocked' : 'done'}`, row.outcome),
          el('span', 'tl__ms', formatElapsed(row.ms)),
        );
        box.appendChild(head);
        if (row.summary) box.appendChild(el('p', 'tl__endsummary', row.summary));
        return box;
      }
    }
  };

  const groupNode = (group: TimelineGroup, roster: TeamRoster | null, inside: string | null): HTMLElement => {
    const box = el('div', 'tl__group');
    // Under a subagent's own block the name is already on the block; naming it again is noise.
    if (group.who !== inside) box.appendChild(whoChip(group.who, roster, true));
    const rows = el('div', 'tl__rows');
    for (const row of group.rows) rows.appendChild(rowNode(row));
    box.appendChild(rows);
    return box;
  };

  const blockNode = (block: SubagentBlock, roster: TeamRoster | null): HTMLElement => {
    const box = el('section', `tl__sub${block.outcome === null ? ' tl__sub--open' : ''}`);
    const head = el('header', 'tl__subhead');
    const chip = whoChip(block.who, roster);
    if (block.role) chip.appendChild(el('span', 'who__role', block.role));
    head.append(chip, el('span', 'tl__subtask', block.task));
    box.appendChild(head);
    const items = el('div', 'tl__subitems');
    for (const item of block.items) items.appendChild(itemNode(item, roster, block.who));
    box.appendChild(items);
    const foot = el('footer', 'tl__subfoot');
    if (block.outcome === null) foot.append(el('span', 'tl__subworking', 'working…'));
    else foot.append(el('span', 'tl__suboutcome', block.outcome), el('span', 'tl__ms', formatDuration(block.ms ?? 0)));
    box.appendChild(foot);
    return box;
  };

  const itemNode = (item: TimelineItem, roster: TeamRoster | null, inside: string | null): HTMLElement =>
    item.kind === 'group' ? groupNode(item, roster, inside) : blockNode(item, roster);

  const renderFeedHead = (turn: TurnRecord | null): void => {
    feedHead.replaceChildren();
    if (!turn) return;
    const running = turn.endedAt === null;
    const title = el('h3', undefined, `Turn · ${formatTime(turn.startedAt)}`);
    const status = running
      ? el('span', 'pill pill--in-progress', 'running')
      : el('span', `pill pill--${turn.outcome && /fail|error|abort/i.test(turn.outcome) ? 'blocked' : 'done'}`, turn.outcome ?? 'ended');
    const dur = el('span', 'activity__elapsed', formatElapsed(turnDuration(turn, now())));
    if (running) dur.dataset.elapsed = String(turn.startedAt);
    const calls = el('span', 'activity__calls', `${turn.toolCalls} tool call${turn.toolCalls === 1 ? '' : 's'}`);
    feedHead.append(title, status, dur, calls);
  };

  const renderFeed = (state: UiState): void => {
    const held = slugTurns(state);
    const turn = held.turns.find((t) => t.sessionId === selectedId) ?? null;
    const sig = turn ? `${turn.sessionId}:${turn.events.length}:${turn.endedAt}` : `none:${held.state}:${held.turns.length}`;
    if (sig === lastFeedSig) return;
    const sameTurn = lastFeedSig.startsWith(`${selectedId}:`);
    lastFeedSig = sig;

    renderFeedHead(turn);
    // Only a scroll position the reader had a say in counts: a fresh turn always starts followed.
    if (sameTurn) following = following && atBottom();
    scroller.replaceChildren();
    if (!turn) {
      scroller.appendChild(el(
        'p', 'empty activity__empty',
        held.state === 'loading' && !held.turns.length ? '' : 'Nothing to show — pick a turn on the left.',
      ));
      return;
    }
    const roster = deps.roster();
    const timeline = el('div', 'tl');
    for (const item of timelineModel(turn.events)) timeline.appendChild(itemNode(item, roster, null));
    if (turn.endedAt === null) timeline.appendChild(el('p', 'tl__live', 'Waiting for the next event…'));
    scroller.appendChild(timeline);
    // A growing turn keeps the newest row in view; a turn just opened starts where it is
    // happening — the end while it runs, the top once it is history.
    if (following && (sameTurn || turn.endedAt === null)) scroller.scrollTop = scroller.scrollHeight;
    else if (!sameTurn) scroller.scrollTop = 0;
  };

  const render = (state: UiState): void => {
    if (!alive) return;
    const held = slugTurns(state);
    if (held === lastTurns && lastListSig && lastFeedSig) return;
    lastTurns = held;
    settleSelection();
    renderList(state);
    renderFeed(state);
  };

  // --- live parts -----------------------------------------------------------------

  const tick = (): void => {
    const t = now();
    for (const node of root.querySelectorAll<HTMLElement>('[data-elapsed]')) {
      node.textContent = formatElapsed(t - Number(node.dataset.elapsed));
    }
  };

  scroller.addEventListener('scroll', () => { following = atBottom(); });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const { turns } = slugTurns();
    if (!turns.length) return;
    const index = turns.findIndex((t) => t.sessionId === selectedId);
    const next = event.key === 'ArrowDown' ? Math.min(turns.length - 1, index + 1) : Math.max(0, index - 1);
    if (next === index) return;
    event.preventDefault();
    select(turns[next].sessionId, true);
    list.querySelector<HTMLElement>(`[data-session="${CSS.escape(String(turns[next].sessionId))}"]`)?.focus();
  };
  root.addEventListener('keydown', onKey);

  const unsubscribe = store.subscribe(render);
  const timer = setInterval(tick, TICK_MS);
  render(store.getState());
  // Focus lands on the selected turn, so the arrow keys work from the first keystroke.
  (list.querySelector<HTMLElement>('[aria-current="true"]') ?? root).focus();

  void getJson<TurnsResponse>(`/api/projects/${ctx.slug}/turns`)
    .then((response) => { if (alive) store.dispatch({ type: 'turns-loaded', slug: ctx.slug, response }); })
    .catch(() => { if (alive) store.dispatch({ type: 'turns-failed', slug: ctx.slug }); });

  return () => {
    alive = false;
    unsubscribe();
    clearInterval(timer);
    root.removeEventListener('keydown', onKey);
    host.replaceChildren();
  };
}
