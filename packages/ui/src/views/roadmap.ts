import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import type { PrdDoc } from '../prd.js';
import { MILESTONE_STATUSES, roadmapEmptyState, roadmapRows, verificationChips, type MilestoneStatus, type RoadmapDoc, type RoadmapRow } from '../roadmap.js';
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
    const item = el('li', row.current ? 'milestone milestone--current' : 'milestone');

    item.appendChild(el('span', 'milestone__order', String(row.order)));

    const text = el('div', 'milestone__text');
    text.appendChild(el('h3', 'milestone__title', row.title));
    if (row.summary) text.appendChild(el('p', 'milestone__summary', row.summary));
    item.appendChild(text);

    const meta = el('div', 'milestone__meta');
    meta.appendChild(el('span', `pill pill--${row.status}`, row.status));
    for (const chip of verificationChips(row.verification)) {
      const mark = el('span', `verify verify--${chip.tone}`, chip.label);
      if (row.verification?.notes) mark.title = row.verification.notes;
      meta.appendChild(mark);
    }
    if (row.estimate) meta.appendChild(el('span', 'milestone__estimate', row.estimate));
    item.appendChild(meta);

    const picker = el('select', 'select');
    for (const status of MILESTONE_STATUSES) {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      picker.appendChild(option);
    }
    picker.value = row.status;
    picker.title = 'Status';
    picker.addEventListener('change', () => {
      edit(
        `/api/projects/${ctx.slug}/roadmap/${encodeURIComponent(row.id)}`,
        { status: picker.value as MilestoneStatus }, 'PATCH',
        `Could not set ${row.title} to ${picker.value}`,
      );
    });

    const moves = el('div', 'milestone__moves');
    for (const [direction, label, can] of [
      ['up', '↑', row.canMoveUp] as const,
      ['down', '↓', row.canMoveDown] as const,
    ]) {
      const move = button(label, 'btn btn--icon');
      move.title = `Move ${direction}`;
      move.disabled = !can;
      move.addEventListener('click', () => {
        edit(`/api/projects/${ctx.slug}/roadmap/move`, { id: row.id, direction }, 'POST',
          `Could not move ${row.title} ${direction}`);
      });
      moves.appendChild(move);
    }

    const controls = el('div', 'milestone__controls');
    controls.append(picker, moves);
    item.appendChild(controls);
    return item;
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
