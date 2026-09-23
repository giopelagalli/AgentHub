import { PRIORITY_RANK, type ProjectManifest } from '@agenthub/shared';
import { policyPillText } from '../models.js';
import type { Store, UiState } from '../store.js';
import { el, priorityPicker } from './projects.js';

const COLUMNS = ['Project', 'Status', 'Order', 'Models', 'Updated'] as const;

const NOTE = 'The Master reorders these automatically during briefings; your setting wins until it changes it again.';

/**
 * The running order: every project that hasn't finished, most urgent first, and
 * the most recently touched first within a priority. Same comparison the hub's
 * queue makes, so the table reads as what actually runs next.
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

/** One table of what runs first, with the priority lever on every row. */
export function mountAllocation(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'allocation');
  const pane = el('section', 'panel');

  const table = el('table', 'table');
  const head = table.createTHead().insertRow();
  for (const column of COLUMNS) {
    const cell = document.createElement('th');
    cell.textContent = column;
    head.appendChild(cell);
  }
  const body = table.createTBody();
  const empty = el('p', 'empty', 'Waiting for the hub…');

  pane.append(el('h2', undefined, 'Running order'), el('p', 'note', NOTE), table, empty);
  page.appendChild(pane);
  host.appendChild(page);

  const render = (state: UiState): void => {
    const rows = allocationRows(state.hub?.projects ?? []);
    body.replaceChildren();
    empty.hidden = rows.length > 0;
    empty.textContent = state.hub ? 'No project is active.' : 'Waiting for the hub…';
    const now = Date.now();
    for (const project of rows) {
      const row = body.insertRow();
      const title = row.insertCell();
      title.append(el('span', 'row__title', project.title), el('span', 'row__slug', project.slug));
      row.insertCell().appendChild(el('span', `pill pill--${project.status}`, project.status));
      row.insertCell().appendChild(priorityPicker(project.slug, project.priority));
      row.insertCell().textContent = policyPillText(project.modelPolicy);
      row.insertCell().textContent = ago(project.updatedAt, now);
    }
  };

  // Priority changes land back through the hub's state broadcast, which is what
  // re-sorts the table — including the ones the Master made on its own.
  let signature = '';
  const unsubscribe = store.subscribe((state) => {
    const next = allocationRows(state.hub?.projects ?? [])
      .map((p) => `${p.slug}:${p.status}:${p.priority}:${policyPillText(p.modelPolicy)}:${p.updatedAt}`).join('|');
    if (next === signature && state.hub) return;
    signature = next;
    render(state);
  });
  render(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
