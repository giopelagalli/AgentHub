import type { Job, NodeInfo } from '@agenthub/shared';
import type { Store, UiState } from '../store.js';
import { el } from './projects.js';

const NODE_COLUMNS = ['Node', 'Status', 'Serving', 'Streams', 'Extras'] as const;
const JOB_COLUMNS = ['Job', 'Type', 'Status', 'Node', 'Attempts', 'Project'] as const;

function table(columns: readonly string[]): { node: HTMLTableElement; body: HTMLTableSectionElement } {
  const node = el('table', 'table');
  const head = node.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.textContent = column;
    head.appendChild(cell);
  }
  return { node, body: node.createTBody() };
}

/** What a node advertises beyond its model endpoints. */
function extras(node: NodeInfo): string {
  const has = [node.browser ? 'browser' : null, node.video ? 'video' : null, node.control ? 'control' : null];
  return has.filter(Boolean).join(', ') || '—';
}

/** Cluster-wide active streams for the tiers this node serves; the hub counts per tier, not per node. */
function streamsFor(node: NodeInfo, streams: Record<string, number>): string {
  const tiers = [...new Set(node.endpoints.map((e) => e.tier))];
  return tiers.length ? tiers.map((tier) => `${tier} ${streams[tier] ?? 0}`).join(', ') : '—';
}

function serving(node: NodeInfo): string {
  return node.endpoints.length ? node.endpoints.map((e) => `${e.tier}: ${e.model}`).join(', ') : '—';
}

function jobRow(job: Job): string[] {
  return [
    `#${job.id}`,
    job.type,
    job.status,
    job.nodeId === null ? '—' : `#${job.nodeId}`,
    String(job.attempts),
    job.project ?? '—',
  ];
}

/** Nodes and jobs, straight off the hub state — so the WS keeps both tables live. */
export function mountCluster(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'cluster');

  const nodesPane = el('section', 'panel');
  const nodes = table(NODE_COLUMNS);
  const nodesEmpty = el('p', 'empty', 'Waiting for the hub…');
  nodesPane.append(el('h2', undefined, 'Nodes'), nodes.node, nodesEmpty);

  const jobsPane = el('section', 'panel');
  const jobs = table(JOB_COLUMNS);
  const jobsEmpty = el('p', 'empty', 'Waiting for the hub…');
  jobsPane.append(el('h2', undefined, 'Jobs'), jobs.node, jobsEmpty);

  page.append(nodesPane, jobsPane);
  host.appendChild(page);

  const fill = (
    body: HTMLTableSectionElement, empty: HTMLElement, rows: string[][], statusAt: number, none: string,
  ): void => {
    body.replaceChildren();
    empty.hidden = rows.length > 0;
    empty.textContent = none;
    body.parentElement?.classList.toggle('table--empty', rows.length === 0);
    for (const values of rows) {
      const row = body.insertRow();
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === statusAt) cell.className = `status status--${value}`;
      });
    }
  };

  const render = (state: UiState): void => {
    const streams = state.hub?.streams ?? {};
    fill(
      nodes.body,
      nodesEmpty,
      (state.hub?.nodes ?? []).map((node) => [
        node.name, node.status, serving(node), streamsFor(node, streams), extras(node),
      ]),
      1,
      state.hub ? 'No node has registered.' : 'Waiting for the hub…',
    );
    fill(
      jobs.body,
      jobsEmpty,
      (state.hub?.jobs ?? []).map(jobRow),
      2,
      state.hub ? 'The queue is empty.' : 'Waiting for the hub…',
    );
  };

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
