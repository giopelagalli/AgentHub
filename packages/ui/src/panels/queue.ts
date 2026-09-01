import type { UiState } from '../store.js';

const COLUMNS = ['Job', 'Type', 'Tier', 'Priority', 'Status', 'Node'] as const;

/** The lobby job board: a snapshot of the hub queue at the moment it opened. */
export function openQueuePanel(host: HTMLElement, state: UiState): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--center';

  const heading = document.createElement('h2');
  heading.textContent = 'Job board';
  panel.appendChild(heading);

  const jobs = state.hub?.jobs ?? [];
  if (jobs.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = state.hub ? 'The queue is empty.' : 'Waiting for the hub...';
    panel.appendChild(empty);
  } else {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const column of COLUMNS) {
      const cell = document.createElement('th');
      cell.textContent = column;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const job of jobs) {
      const row = body.insertRow();
      for (const value of [
        `#${job.id}`,
        job.type,
        job.tier,
        job.priority,
        job.status,
        job.nodeId === null ? '—' : `#${job.nodeId}`,
      ]) {
        row.insertCell().textContent = value;
      }
    }
    panel.appendChild(table);
  }

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to close';
  panel.appendChild(hint);

  host.appendChild(panel);
  return () => panel.remove();
}
