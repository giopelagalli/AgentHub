import { PRIORITY_RANK, type ProjectManifest } from '@agenthub/shared';
import { el } from '../dom.js';
import { policyPillText } from '../models.js';
import type { Store, UiState } from '../store.js';
import { priorityPicker } from './project/controls.js';

const NOTE = 'What gets the machines first when they are busy. The Master reorders projects during its briefings; your choice holds until it does.';

/**
 * The running order: every project that hasn't finished, most urgent first, and
 * the most recently touched first within a priority. Same comparison the hub's
 * queue makes, so the list reads as what actually runs next.
 */
export function allocationRows(projects: ProjectManifest[]): ProjectManifest[] {
  return projects
    .filter((p) => p.status !== 'done')
    .slice()
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt);
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const STATUS_DOT: Record<ProjectManifest['status'], string> = {
  active: 'dot dot--idle',
  paused: 'dot dot--paused',
  blocked: 'dot dot--needs',
  done: 'dot dot--done',
};

/** The running order, with the priority lever on every row. */
export function mountAllocation(host: HTMLElement, store: Store): () => void {
  const page = el('section', 'msection');
  const head = el('div', 'msection__head');
  const titles = el('div', 'msection__titles');
  titles.append(el('h2', 'msection__title', 'Running order'), el('p', 'msection__sub', NOTE));
  head.appendChild(titles);
  const list = el('div', 'mlist');
  const empty = el('p', 'empty', 'Waiting for the hub…');
  page.append(head, list, empty);
  host.appendChild(page);

  const render = (state: UiState): void => {
    const rows = allocationRows(state.hub?.projects ?? []);
    list.hidden = !rows.length;
    empty.hidden = rows.length > 0;
    empty.textContent = state.hub ? 'No project is active.' : 'Waiting for the hub…';
    const now = Date.now();
    list.replaceChildren(...rows.map((project, index) => {
      const row = el('div', 'mrow');
      const order = el('span', 'mrow__order num', String(index + 1));
      const text = el('div', 'mrow__text');
      const top = el('div', 'mrow__top');
      const dot = el('span', STATUS_DOT[project.status]);
      dot.title = project.status;
      top.append(dot, el('span', 'mrow__name', project.title));
      if (project.status !== 'active') top.appendChild(el('span', 'mrow__tag', project.status));
      text.append(top, el('span', 'mrow__sub', `${policyPillText(project.modelPolicy)} · updated ${ago(project.updatedAt, now)}`));
      const side = el('div', 'mrow__side');
      side.appendChild(priorityPicker(project.slug, project.priority));
      row.append(order, text, side);
      return row;
    }));
  };

  // Priority changes land back through the hub's state broadcast, which is what
  // re-sorts the list — including the ones the Master made on its own. Not while a
  // picker is open under the owner, though: the next frame catches it up.
  let signature = '';
  const unsubscribe = store.subscribe((state) => {
    const next = allocationRows(state.hub?.projects ?? [])
      .map((p) => `${p.slug}:${p.title}:${p.status}:${p.priority}:${policyPillText(p.modelPolicy)}:${p.updatedAt}`).join('|');
    if ((next === signature && state.hub) || list.contains(document.activeElement)) return;
    signature = next;
    render(state);
  });
  render(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
