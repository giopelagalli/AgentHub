import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import type { PrdDoc } from '../prd.js';
import { icon } from '../icons.js';
import { menuButton } from '../menu.js';
import { MILESTONE_STATUSES, STATUS_WORDS, dropMove, roadmapEmptyState, roadmapRows, verificationChips, type RoadmapDoc, type RoadmapRow } from '../roadmap.js';
import { streamPost } from '../stream.js';
import { toast } from '../toast.js';
import { chatToAdjust, docBar, note, type ViewContext } from './parts.js';

/**
 * The roadmap view: the milestones in the order they will be done, with the two edits that don't
 * need a conversation — move one up or down, and change its status.
 */
export interface RoadmapOptions {
  /** Start the generator straight away — the Overview's "Generate the roadmap" lands here. */
  generate?: boolean;
}

export function mountRoadmap(host: HTMLElement, ctx: ViewContext, options: RoadmapOptions = {}): () => void {
  let doc: RoadmapDoc | null = null;
  /** Whether the PRD exists yet, for the empty state; unknown defaults to true (today's behavior). */
  let prdDrafted = true;
  let state: 'loading' | 'ready' | 'failed' = 'loading';
  let failure = '';
  let token = 0;
  let alive = true;
  /** Set while the generator is streaming; aborted if the view goes away under it. */
  let generating: AbortController | null = null;
  /** The row being dragged, while one is. */
  let dragging: RoadmapRow | null = null;
  /** A row moved from the keyboard keeps focus once the list is redrawn. */
  let focusAfterLoad: string | null = null;

  const load = (): void => {
    const mine = ++token;
    if (!doc) state = 'loading';
    void Promise.all([
      getJson<RoadmapDoc>(`/api/projects/${ctx.slug}/roadmap`),
      // The PRD only decides what the empty state offers; a failed fetch shouldn't fail the roadmap.
      getJson<PrdDoc>(`/api/projects/${ctx.slug}/prd`).catch(() => null),
    ])
      .then(([next, prd]) => {
        if (mine !== token || !alive) return;
        doc = next;
        prdDrafted = prd?.drafted ?? true;
        state = 'ready';
        render();
      })
      .catch((error: unknown) => {
        if (mine !== token || !alive) return;
        state = 'failed';
        failure = `Could not load the roadmap: ${String(error)}`;
        render();
      });
  };

  /** Every edit is the same shape: post it, say what went wrong, then re-read the truth. */
  const edit = (url: string, body: unknown, method: string, whenBad: string): void => {
    void sendJson(url, body, method)
      .catch((error: unknown) => toast(`${whenBad}: ${String(error)}`, 'error'))
      .finally(() => { if (alive) load(); });
  };

  const rowNode = (row: RoadmapRow): HTMLElement => {
    const item = el('li', `milestone milestone--${row.status}${row.current ? ' milestone--current' : ''}`);
    item.dataset.id = row.id;
    item.tabIndex = 0;
    item.setAttribute('aria-label', `${row.title}, ${STATUS_WORDS[row.status].toLowerCase()}${row.current ? ', current' : ''}`);

    // The glyph is the status, and pressing it is how the status changes: ✓ done, ● in progress,
    // ○ planned, ! blocked.
    const glyph = button('', `milestone__glyph milestone__glyph--${row.status}`);
    glyph.title = `${STATUS_WORDS[row.status]} — change`;
    glyph.setAttribute('aria-label', `Status: ${STATUS_WORDS[row.status]}. Change status`);
    if (row.status === 'done') glyph.appendChild(icon('check', 12));
    if (row.status === 'blocked') glyph.textContent = '!';
    menuButton(glyph, () => MILESTONE_STATUSES.map((status) => ({
      label: STATUS_WORDS[status],
      ...(status === row.status ? { icon: 'check' as const } : {}),
      onSelect: () => {
        if (status === row.status) return;
        edit(
          `/api/projects/${ctx.slug}/roadmap/${encodeURIComponent(row.id)}`,
          { status }, 'PATCH',
          `Could not set ${row.title} to ${STATUS_WORDS[status].toLowerCase()}`,
        );
      },
    })));
    item.appendChild(glyph);

    const text = el('div', 'milestone__text');
    const titleLine = el('div', 'milestone__titleline');
    titleLine.appendChild(el('h3', 'milestone__title', row.title));
    if (row.current) titleLine.appendChild(el('span', 'milestone__now', 'Current'));
    text.appendChild(titleLine);
    if (row.summary) text.appendChild(el('p', 'milestone__summary', row.summary));
    const meta = el('div', 'milestone__meta');
    for (const chip of verificationChips(row.verification)) {
      const mark = el('span', `verify verify--${chip.tone}`, chip.label);
      if (row.verification?.notes) mark.title = row.verification.notes;
      meta.appendChild(mark);
    }
    if (row.estimate) meta.appendChild(el('span', 'milestone__estimate', row.estimate));
    if (meta.childElementCount) text.appendChild(meta);
    item.appendChild(text);

    const moves = el('div', 'milestone__moves');
    for (const [direction, name, can] of [
      ['up', 'arrowUp', row.canMoveUp] as const,
      ['down', 'arrowDown', row.canMoveDown] as const,
    ]) {
      const move = button('', 'btn btn--icon');
      move.appendChild(icon(name, 16));
      move.title = `Move ${direction} (Option-${direction === 'up' ? '↑' : '↓'})`;
      move.setAttribute('aria-label', `Move ${row.title} ${direction}`);
      move.disabled = !can;
      move.addEventListener('click', () => moveBy(row, direction === 'up' ? -1 : 1));
      moves.appendChild(move);
    }
    item.appendChild(moves);

    // Option-↑/↓ on a focused row moves it, as the buttons do.
    item.addEventListener('keydown', (event) => {
      if (event.target !== item || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      if (event.key === 'ArrowUp' ? row.canMoveUp : row.canMoveDown) {
        focusAfterLoad = row.id;
        moveBy(row, event.key === 'ArrowUp' ? -1 : 1);
      }
    });

    // Dragging a row onto another moves it there, one step at a time — the hub's only move is a step.
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      dragging = row;
      item.classList.add('milestone--dragging');
      event.dataTransfer?.setData('text/plain', row.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      dragging = null;
      item.classList.remove('milestone--dragging');
      for (const node of host.querySelectorAll('.milestone--over')) node.classList.remove('milestone--over');
    });
    item.addEventListener('dragover', (event) => {
      if (!dragging || dragging.id === row.id) return;
      event.preventDefault();
      item.classList.add('milestone--over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('milestone--over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('milestone--over');
      if (dragging && dragging.id !== row.id) moveRow(dragging, dropMove(dragging, row), `to place ${row.order}`);
    });
    return item;
  };

  /** Moves `row` one place (negative is up) from the keyboard or a button. */
  const moveBy = (row: RoadmapRow, steps: number): void => {
    const direction = steps < 0 ? 'up' : 'down';
    moveRow(row, { id: row.id, direction }, direction);
  };

  /** Sends one move to the hub, then re-reads the roadmap. */
  const moveRow = (row: RoadmapRow, body: { id: string; direction: 'up' | 'down' } | { id: string; to: number }, where: string): void => {
    sendJson(`/api/projects/${ctx.slug}/roadmap/move`, body, 'POST')
      .catch((error: unknown) => toast(`Could not move ${row.title} ${where}: ${String(error)}`, 'error'))
      .finally(() => { if (alive) load(); });
  };

  /** Generating runs in place of the list, so the sheet shows the work rather than going blank. */
  const generate = (): void => {
    host.replaceChildren();
    const progress = el('pre', 'stream');
    progress.setAttribute('aria-live', 'polite');
    const line = el('p', 'modal__note', 'Reading the PRD and planning the milestones…');
    const cancel = button('Cancel');
    const actions = el('div', 'actions');
    actions.appendChild(cancel);
    host.append(line, progress, actions);

    const controller = new AbortController();
    generating = controller;
    cancel.addEventListener('click', () => { controller.abort(); generating = null; render(); load(); });

    void streamPost(`/api/projects/${ctx.slug}/roadmap/generate`, {}, controller.signal, (chunk) => {
      const following = progress.scrollHeight - progress.scrollTop - progress.clientHeight < 12;
      progress.textContent += chunk;
      if (following) progress.scrollTop = progress.scrollHeight;
    })
      .then(() => {
        generating = null;
        if (alive) { toast('Roadmap generated.'); load(); }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !alive) return;
        generating = null;
        line.textContent = 'The generator stopped early.';
        toast(`Could not generate the roadmap: ${String(error)}`, 'error');
        const again = button('Back to the roadmap');
        again.addEventListener('click', render);
        actions.appendChild(again);
      });
  };

  function render(): void {
    host.replaceChildren();
    const { bar, actions } = docBar(ctx);
    host.appendChild(bar);

    if (state === 'loading') { host.appendChild(note('Loading the roadmap…')); return; }

    if (state === 'failed') {
      host.appendChild(note(failure, 'error'));
      const retry = button('Try again');
      retry.addEventListener('click', load);
      actions.appendChild(retry);
      return;
    }

    const rows = roadmapRows(doc);
    if (!rows.length) {
      const info = roadmapEmptyState(prdDrafted);
      const empty = el('div', 'blank');
      empty.append(
        el('p', 'blank__line', info.line),
        el('p', 'blank__hint', info.hint),
      );
      const start = el('button', 'btn btn--primary', info.action === 'generate' ? 'Generate roadmap' : 'Go to the PRD');
      start.type = 'button';
      start.addEventListener('click', info.action === 'generate' ? generate : () => ctx.openArtifact('prd'));
      empty.appendChild(start);
      host.appendChild(empty);
      return;
    }

    actions.appendChild(chatToAdjust(ctx, 'roadmap', load));
    const list = el('ol', 'roadmap');
    for (const row of rows) list.appendChild(rowNode(row));
    host.appendChild(list);
    if (focusAfterLoad) {
      list.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusAfterLoad)}"]`)?.focus();
      focusAfterLoad = null;
    }
  }

  if (options.generate) generate();
  else {
    render();
    load();
  }

  return () => {
    alive = false;
    token++;
    generating?.abort();
    host.replaceChildren();
  };
}
