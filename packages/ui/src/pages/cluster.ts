import type { Job, NodeInfo, UsageReport } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import type { Store, UiState } from '../store.js';
import { toast } from '../toast.js';
import { formatUsd } from '../turns.js';
import { button, el } from './projects.js';

const NODE_COLUMNS = ['Node', 'Status', 'Serving', 'Streams', 'Extras', 'Actions'] as const;
const JOB_COLUMNS = ['Job', 'Type', 'Status', 'Node', 'Attempts', 'Project'] as const;

/** Column indexes whose cells hold identifiers — names, ids, model strings — and so set in mono. */
const NODE_MONO = new Set([0, 2, 3]);
const JOB_MONO = new Set([0, 1, 3, 5]);

/** How often the cloud spend line is re-read while the page is open. */
const SPEND_REFRESH_MS = 30_000;

/** `Cloud spend: $1.20 in the last 24 h`, and the cap it is running against when there is one. */
export function cloudSpendText(report: UsageReport | null): string {
  if (!report) return 'Cloud spend: reading…';
  const cap = report.cap.maxCloudUsdPerDay;
  const spent = report.cap.cloudUsdToday;
  return `Cloud spend: ${spent > 0 ? formatUsd(spent) : '$0.00'} in the last 24 h${cap === null ? '' : ` · cap ${formatUsd(cap)}`}`;
}

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

/** Which buttons a node's row gets. The synthetic cloud nodes aren't machines, so they get none. */
export function nodeActions(node: NodeInfo): ('drain' | 'undrain' | 'remove')[] {
  if (node.arch === 'cloud') return [];
  return [node.draining ? 'undrain' : 'drain', 'remove'];
}

/** One row's Drain/Undrain/Remove button, wired straight to the hub; the WS broadcast repaints the row. */
function actionButton(node: NodeInfo, action: 'drain' | 'undrain' | 'remove'): HTMLButtonElement {
  if (action === 'remove') {
    const remove = button('Remove');
    remove.addEventListener('click', () => {
      if (!window.confirm(`Remove ${node.name}? Its daemon will exit; re-run its install to add it back.`)) return;
      void sendJson(`/api/nodes/${node.name}`, undefined, 'DELETE')
        .catch((error: unknown) => toast(`Could not remove ${node.name}: ${String(error)}`, 'error'));
    });
    return remove;
  }
  const drain = button(action === 'drain' ? 'Drain' : 'Undrain');
  drain.addEventListener('click', () => {
    void sendJson(`/api/nodes/${node.name}/drain`, { on: action === 'drain' })
      .catch((error: unknown) => toast(`Could not ${action} ${node.name}: ${String(error)}`, 'error'));
  });
  return drain;
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
  // What the cloud half of the cluster has cost, above the machines it was spent on.
  const spend = el('p', 'cluster__spend', cloudSpendText(null));
  nodesPane.append(el('h2', undefined, 'Nodes'), spend, nodes.node, nodesEmpty);

  const jobsPane = el('section', 'panel');
  const jobs = table(JOB_COLUMNS);
  const jobsEmpty = el('p', 'empty', 'Waiting for the hub…');
  jobsPane.append(el('h2', undefined, 'Jobs'), jobs.node, jobsEmpty);

  page.append(nodesPane, jobsPane);
  host.appendChild(page);

  const fill = (
    body: HTMLTableSectionElement, empty: HTMLElement, rows: string[][], statusAt: number, none: string,
    mono: ReadonlySet<number>,
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
        else if (mono.has(index)) cell.className = 'mono';
      });
    }
  };

  const render = (state: UiState): void => {
    const streams = state.hub?.streams ?? {};
    // Not routed through fill(): the Actions cell holds live buttons, not a plain string.
    const nodeRows = state.hub?.nodes ?? [];
    nodes.body.replaceChildren();
    nodesEmpty.hidden = nodeRows.length > 0;
    nodesEmpty.textContent = state.hub ? 'No node has registered.' : 'Waiting for the hub…';
    nodes.body.parentElement?.classList.toggle('table--empty', nodeRows.length === 0);
    for (const node of nodeRows) {
      const row = nodes.body.insertRow();
      const values = [node.name, node.draining ? 'draining' : node.status, serving(node), streamsFor(node, streams), extras(node)];
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === 1) cell.className = `status status--${value}`;
        else if (NODE_MONO.has(index)) cell.className = 'mono';
      });
      const actionsCell = row.insertCell();
      const actions = nodeActions(node);
      if (actions.length) actions.forEach((action) => actionsCell.appendChild(actionButton(node, action)));
      else actionsCell.textContent = '—';
    }
    fill(
      jobs.body,
      jobsEmpty,
      (state.hub?.jobs ?? []).map(jobRow),
      2,
      state.hub ? 'The queue is empty.' : 'Waiting for the hub…',
      JOB_MONO,
    );
  };

  const loadSpend = (): void => {
    void getJson<UsageReport>('/api/usage/summary')
      .then((report) => { spend.textContent = cloudSpendText(report); })
      .catch(() => { /* leave the last figure up; the tables already show a hub that went quiet */ });
  };
  loadSpend();
  // Spend moves with turns, not with the hub state frames these tables follow, so it has its own
  // slow refresh rather than a fetch per broadcast.
  const spendTimer = setInterval(loadSpend, SPEND_REFRESH_MS);

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  return () => {
    unsubscribe();
    clearInterval(spendTimer);
    page.remove();
  };
}
