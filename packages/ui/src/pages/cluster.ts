import type { Job, NodeInfo } from '@agenthub/shared';
import { sendJson } from '../api.js';
import type { Store, UiState } from '../store.js';
import { toast } from '../toast.js';
import { button, el } from './projects.js';

const NODE_COLUMNS = ['Node', 'Owner', 'Status', 'Serving', 'Streams', 'Extras', 'Actions'] as const;
const JOB_COLUMNS = ['Job', 'Type', 'Status', 'Node', 'Attempts', 'Project'] as const;

/** Column indexes whose cells hold identifiers — names, ids, model strings — and so set in mono. */
const NODE_MONO = new Set([0, 1, 3, 4]);
const JOB_MONO = new Set([0, 1, 3, 5]);
/** The node column carrying the status word: it gets the status colour instead of mono. */
const NODE_STATUS_AT = 2;

/** What `POST /api/nodes/enrollment-tokens` answers with; the hub builds the command, not the page. */
interface NodeEnrollment {
  token: string;
  expiresAt: number;
  command: string;
}

/** The line under the install command, saying how long it stays good for. */
export function enrollmentExpiry(expiresAt: number, now: number): string {
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (minutes <= 0) return 'This command has expired — press Add node for a fresh one.';
  if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  const hours = Math.round(minutes / 60);
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}.`;
}

/** What the owner is being asked to do with the command, in one line (PRD FR-D1). */
export const ADD_NODE_NOTE =
  'Run this on the machine to add. It installs the node daemon, enrolls it under your account, and starts it.';

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

/**
 * The *Add node* panel: one button that mints a one-time enrollment token and shows the command it
 * belongs to. The command is the hub's — it knows the URL the new machine has to call back on —
 * so this only displays it and puts it on the clipboard.
 */
function addNodePanel(): { head: HTMLElement; panel: HTMLElement } {
  const head = el('div', 'cluster__head');
  const add = button('Add node', 'btn btn--primary');
  head.append(el('h2', undefined, 'Nodes'), add);

  const panel = el('div', 'addnode');
  panel.hidden = true;
  const command = el('input', 'input mono addnode__cmd');
  command.readOnly = true;
  const copy = button('Copy');
  const expiry = el('p', 'addnode__expiry');
  const row = el('div', 'addnode__row');
  row.append(command, copy);
  panel.append(row, el('p', 'addnode__note', ADD_NODE_NOTE), expiry);

  add.addEventListener('click', () => {
    add.disabled = true;
    void sendJson<NodeEnrollment>('/api/nodes/enrollment-tokens')
      .then((enrollment) => {
        if (!enrollment) return;
        command.value = enrollment.command;
        expiry.textContent = enrollmentExpiry(enrollment.expiresAt, Date.now());
        copy.textContent = 'Copy';
        panel.hidden = false;
        command.select();
      })
      .catch((error: unknown) => toast(`Could not mint an enrollment token: ${String(error)}`, 'error'))
      .finally(() => { add.disabled = false; });
  });

  copy.addEventListener('click', () => {
    // There is no clipboard API outside a secure context, and writing can be refused even where
    // there is one. Either way the command is selected instead, so the button never does nothing.
    const selectInstead = () => {
      command.select();
      toast('Could not reach the clipboard — the command is selected, copy it by hand.', 'error');
    };
    const written = navigator.clipboard?.writeText(command.value);
    if (!written) return selectInstead();
    void written.then(() => { copy.textContent = 'Copied'; }).catch(selectInstead);
  });

  return { head, panel };
}

/** Nodes and jobs, straight off the hub state — so the WS keeps both tables live. */
export function mountCluster(host: HTMLElement, store: Store): () => void {
  const page = el('div', 'cluster');

  const nodesPane = el('section', 'panel');
  const nodes = table(NODE_COLUMNS);
  const nodesEmpty = el('p', 'empty', 'Waiting for the hub…');
  const addNode = addNodePanel();
  nodesPane.append(addNode.head, addNode.panel, nodes.node, nodesEmpty);

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
      const values = [
        node.name, node.owner, node.draining ? 'draining' : node.status,
        serving(node), streamsFor(node, streams), extras(node),
      ];
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === NODE_STATUS_AT) cell.className = `status status--${value}`;
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

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  return () => {
    unsubscribe();
    page.remove();
  };
}
