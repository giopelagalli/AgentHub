import type { Job, NodeInfo, UsageReport } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { githubLineText, type GithubStatus } from '../github.js';
import { icon } from '../icons.js';
import { menuButton, type MenuEntry } from '../menu.js';
import type { Store, UiState } from '../store.js';
import { toast } from '../toast.js';
import { iconButton } from '../toolbar.js';
import { formatUsd } from '../turns.js';

/**
 * Three of Machines' sections: the nodes the hub runs on (with the cloud spend over them), the job
 * queue, and access — the API tokens that open the hub's OpenAI-compatible door and the GitHub
 * connection. Nodes and jobs come straight off the hub state, so the socket keeps them live.
 */

/** What `POST /api/nodes/enrollment-tokens` answers with; the hub builds the command, not the page. */
interface NodeEnrollment {
  token: string;
  expiresAt: number;
  command: string;
}

/** The line under the install command, saying how long it stays good for. */
export function enrollmentExpiry(expiresAt: number, now: number): string {
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (minutes <= 0) return 'This command has expired — press Add machine for a fresh one.';
  if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  const hours = Math.round(minutes / 60);
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}.`;
}

/** What the owner is being asked to do with the command, in one line (PRD FR-D1). */
export const ADD_NODE_NOTE =
  'Run this on the machine to add. It installs the node daemon, enrolls it under your account, and starts it.';

/** How often the cloud spend line is re-read while the page is open. */
const SPEND_REFRESH_MS = 30_000;

/** `Cloud spend: $1.20 in the last 24 h`, and the cap it is running against when there is one. */
export function cloudSpendText(report: UsageReport | null): string {
  if (!report) return 'Cloud spend: reading…';
  const cap = report.cap.maxCloudUsdPerDay;
  const spent = report.cap.cloudUsdToday;
  return `Cloud spend: ${spent > 0 ? formatUsd(spent) : '$0.00'} in the last 24 h${cap === null ? '' : ` · cap ${formatUsd(cap)}`}`;
}

type NodeAction = 'drain' | 'undrain' | 'pause-models' | 'resume-models' | 'remove';

/**
 * Which entries a node's ⋯ menu gets. The synthetic cloud nodes aren't machines, so they get none;
 * pausing models only means something for a node that serves some.
 */
export function nodeActions(node: NodeInfo): NodeAction[] {
  if (node.arch === 'cloud') return [];
  const actions: NodeAction[] = [node.draining ? 'undrain' : 'drain'];
  if (node.endpoints.length) actions.push(node.modelsPaused ? 'resume-models' : 'pause-models');
  actions.push('remove');
  return actions;
}

/** What a node advertises beyond its model endpoints. */
function extras(node: NodeInfo): string[] {
  return [node.browser ? 'browser' : null, node.video ? 'video' : null, node.control ? 'control' : null]
    .filter((x): x is string => !!x);
}

/** Cluster-wide active streams for the tiers this node serves; the hub counts per tier, not per node. */
function streamsFor(node: NodeInfo, streams: Record<string, number>): string {
  const tiers = [...new Set(node.endpoints.map((e) => e.tier))];
  return tiers.map((tier) => `${tier} ${streams[tier] ?? 0}`).join(' · ');
}

function serving(node: NodeInfo): string {
  return node.endpoints.length ? node.endpoints.map((e) => `${e.tier}: ${e.model}`).join(' · ') : 'No models';
}

/** A section heading with an optional line under it and an action on the right. */
function sectionHead(title: string, sub?: HTMLElement | string, action?: HTMLElement): HTMLElement {
  const head = el('div', 'msection__head');
  const text = el('div', 'msection__titles');
  text.appendChild(el('h2', 'msection__title', title));
  if (sub) text.appendChild(typeof sub === 'string' ? el('p', 'msection__sub', sub) : sub);
  head.appendChild(text);
  if (action) head.appendChild(action);
  return head;
}

/** A read-only field with a Copy button: an install command, a freshly minted token. */
function copyBox(note: string, what: string): { root: HTMLElement; show: (value: string, extra?: string) => void } {
  const root = el('div', 'reveal');
  root.hidden = true;
  const field = el('input', 'input mono reveal__value');
  field.readOnly = true;
  field.setAttribute('aria-label', what);
  const copy = button('', 'btn btn--small');
  copy.append(icon('copy', 14), document.createTextNode('Copy'));
  const row = el('div', 'reveal__row');
  row.append(field, copy);
  const extra = el('p', 'reveal__extra');
  root.append(row, el('p', 'reveal__note', note), extra);

  copy.addEventListener('click', () => {
    // There is no clipboard API outside a secure context, and writing can be refused even where
    // there is one. Either way the value is selected instead, so the button never does nothing.
    const selectInstead = (): void => {
      field.select();
      toast(`Could not reach the clipboard — the ${what.toLowerCase()} is selected, copy it by hand.`, 'error');
    };
    const written = navigator.clipboard?.writeText(field.value);
    if (!written) return selectInstead();
    void written.then(() => { copy.lastChild!.textContent = 'Copied'; }).catch(selectInstead);
  });

  return {
    root,
    show: (value, extraText) => {
      field.value = value;
      extra.textContent = extraText ?? '';
      extra.hidden = !extraText;
      copy.lastChild!.textContent = 'Copy';
      root.hidden = false;
      field.select();
    },
  };
}

/** The dot a node's state earns: green online, amber draining, red offline. */
function nodeDot(node: NodeInfo): string {
  if (node.draining || node.modelsPaused) return 'dot dot--needs';
  return node.status === 'online' ? 'dot dot--working' : 'dot dot--error';
}

/** One node as a row of the grouped list, with its Drain/Remove behind a ⋯ menu. */
function nodeRow(node: NodeInfo, streams: Record<string, number>): HTMLElement {
  const row = el('div', 'mrow');
  const dot = el('span', nodeDot(node));
  const state = node.draining ? 'draining' : node.modelsPaused ? 'models paused' : node.status;
  dot.title = state;
  const text = el('div', 'mrow__text');
  const top = el('div', 'mrow__top');
  top.append(el('span', 'mrow__name', node.name), el('span', `mrow__state mrow__state--${state.replace(' ', '-')}`, state));
  if (node.arch === 'cloud') top.appendChild(el('span', 'mrow__tag', 'cloud'));
  for (const extra of extras(node)) top.appendChild(el('span', 'mrow__tag', extra));
  text.append(top, el('span', 'mrow__sub mono', serving(node)));
  row.append(dot, text);

  const side = el('div', 'mrow__side');
  const live = streamsFor(node, streams);
  if (live) side.appendChild(el('span', 'mrow__meta num', live));
  side.appendChild(el('span', 'mrow__meta', node.owner));
  const actions = nodeActions(node);
  if (actions.length) {
    const more = iconButton('more', `Actions for ${node.name}`);
    menuButton(more, (): MenuEntry[] => actions.map((action) => action === 'remove'
      ? {
        label: 'Remove…', icon: 'trash', danger: true,
        onSelect: () => {
          if (!window.confirm(`Remove ${node.name}? Its daemon will exit; re-run its install to add it back.`)) return;
          void sendJson(`/api/nodes/${encodeURIComponent(node.name)}`, undefined, 'DELETE')
            .catch((error: unknown) => toast(`Could not remove ${node.name}: ${String(error)}`, 'error'));
        },
      }
      : action === 'pause-models' || action === 'resume-models'
      ? {
        label: action === 'pause-models' ? 'Pause models — stop using this node for generation' : 'Resume models — use this node again',
        icon: action === 'pause-models' ? 'pause' : 'play',
        onSelect: () => {
          void sendJson(`/api/nodes/${encodeURIComponent(node.name)}/models`, { paused: action === 'pause-models' })
            .catch((error: unknown) => toast(`Could not ${action === 'pause-models' ? 'pause' : 'resume'} models on ${node.name}: ${String(error)}`, 'error'));
        },
      }
      : {
        label: action === 'drain' ? 'Drain — finish work, take none' : 'Undrain — take work again',
        icon: action === 'drain' ? 'pause' : 'play',
        onSelect: () => {
          void sendJson(`/api/nodes/${encodeURIComponent(node.name)}/drain`, { on: action === 'drain' })
            .catch((error: unknown) => toast(`Could not ${action} ${node.name}: ${String(error)}`, 'error'));
        },
      }));
    side.appendChild(more);
  }
  row.appendChild(side);
  return row;
}

/** Nodes: the cloud spend, Add machine, and every machine the hub knows about. */
export function mountNodes(host: HTMLElement, store: Store): () => void {
  const page = el('section', 'msection');
  const spend = el('p', 'msection__sub num', cloudSpendText(null));
  const add = button('', 'btn btn--primary');
  add.append(icon('plus', 15), document.createTextNode('Add machine'));
  const enroll = copyBox(ADD_NODE_NOTE, 'Install command');
  const list = el('div', 'mlist');
  const empty = el('p', 'empty', 'Waiting for the hub…');
  page.append(sectionHead('Nodes', spend, add), enroll.root, list, empty);
  host.appendChild(page);

  add.addEventListener('click', () => {
    add.disabled = true;
    void sendJson<NodeEnrollment>('/api/nodes/enrollment-tokens')
      .then((enrollment) => {
        if (enrollment) enroll.show(enrollment.command, enrollmentExpiry(enrollment.expiresAt, Date.now()));
      })
      .catch((error: unknown) => toast(`Could not mint an enrollment token: ${String(error)}`, 'error'))
      .finally(() => { add.disabled = false; });
  });

  let last = '';
  const render = (state: UiState): void => {
    const nodes = state.hub?.nodes ?? [];
    const streams = state.hub?.streams ?? {};
    const sig = JSON.stringify([state.hub ? 1 : 0, nodes, streams]);
    if (sig === last) return;
    last = sig;
    list.replaceChildren(...nodes.map((node) => nodeRow(node, streams)));
    list.hidden = !nodes.length;
    empty.hidden = nodes.length > 0;
    empty.textContent = state.hub ? 'No machine has registered yet — Add machine gives you the command.' : 'Waiting for the hub…';
  };

  const loadSpend = (): void => {
    void getJson<UsageReport>('/api/usage/summary')
      .then((report) => { spend.textContent = cloudSpendText(report); })
      .catch(() => { /* leave the last figure up; the list already shows a hub that went quiet */ });
  };
  loadSpend();
  // Spend moves with turns, not with the hub state frames the list follows, so it has its own slow
  // refresh rather than a fetch per broadcast.
  const spendTimer = setInterval(loadSpend, SPEND_REFRESH_MS);

  const unsubscribe = store.subscribe(render);
  render(store.getState());
  return () => {
    unsubscribe();
    clearInterval(spendTimer);
    page.remove();
  };
}

const JOB_COLUMNS = ['Job', 'Type', 'Status', 'Node', 'Attempts', 'Project'] as const;
/** Column indexes whose cells hold identifiers — set in mono. */
const JOB_MONO = new Set([0, 1, 3, 5]);

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

/** Jobs: the queue the nodes work through, straight off the hub state. */
export function mountJobs(host: HTMLElement, store: Store): () => void {
  const page = el('section', 'msection');
  const table = el('table', 'table');
  const head = table.createTHead().insertRow();
  for (const column of JOB_COLUMNS) head.appendChild(el('th', undefined, column));
  const body = table.createTBody();
  const empty = el('p', 'empty', 'Waiting for the hub…');
  const wrap = el('div', 'mtable');
  wrap.appendChild(table);
  page.append(sectionHead('Jobs', 'Work handed to the machines, newest first.'), wrap, empty);
  host.appendChild(page);

  const render = (state: UiState): void => {
    const rows = (state.hub?.jobs ?? []).map(jobRow);
    body.replaceChildren();
    empty.hidden = rows.length > 0;
    wrap.hidden = !rows.length;
    empty.textContent = state.hub ? 'The queue is empty.' : 'Waiting for the hub…';
    for (const values of rows) {
      const row = body.insertRow();
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === 2) cell.className = `status status--${value}`;
        else if (JOB_MONO.has(index)) cell.className = 'mono';
      });
    }
  };
  const unsubscribe = store.subscribe(render);
  render(store.getState());
  return () => {
    unsubscribe();
    page.remove();
  };
}

/** One API token as `GET /api/tokens` reports it — never its hash, never its plaintext. */
interface ApiTokenView {
  id: number;
  kind: 'assistant' | 'agent';
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** What `POST /api/tokens` answers with: the view plus the one and only look at the secret. */
interface MintedApiToken extends ApiTokenView {
  token: string;
}

/** The line under a freshly minted token — it is the only time the hub will ever show it. */
export const NEW_TOKEN_NOTE =
  'Copy it now: the hub stores only a hash, so this is the last time it can be shown. '
  + 'Use it as the API key of any OpenAI-compatible client, against this hub’s /v1.';

/** A timestamp as the table shows it; a token nothing has used yet has no last-used date. */
export function tokenWhen(at: number | null): string {
  return at === null ? 'never' : new Date(at).toLocaleString();
}

/**
 * The *API tokens* section (PRD FR-D6): what opens the hub's OpenAI-compatible door. A token is
 * minted with a label and a kind — `assistant` goes ahead of `agent` on a shared server (decision
 * 0020) — shown once, and revocable from the same list.
 */
function apiTokensSection(): HTMLElement {
  const pane = el('section', 'msection');
  const form = el('form', 'mform');
  const label = el('input', 'input');
  label.placeholder = 'Label, e.g. laptop';
  label.setAttribute('aria-label', 'Token label');
  const kind = el('select', 'select');
  kind.setAttribute('aria-label', 'Kind');
  for (const [value, words] of [['assistant', 'Assistant — goes first'], ['agent', 'Agent']] as const) {
    const option = el('option', undefined, words);
    option.value = value;
    kind.appendChild(option);
  }
  const create = el('button', 'btn btn--primary', 'Create token');
  create.type = 'submit';
  form.append(label, kind, create);

  const reveal = copyBox(NEW_TOKEN_NOTE, 'Token');
  const list = el('div', 'mlist');
  const empty = el('p', 'empty', 'No API tokens yet.');
  pane.append(
    sectionHead('API tokens', 'Keys for OpenAI-compatible clients that talk to this hub’s /v1.'),
    form, reveal.root, list, empty,
  );

  const render = (tokens: ApiTokenView[]): void => {
    empty.hidden = tokens.length > 0;
    list.hidden = !tokens.length;
    list.replaceChildren(...tokens.map((token) => {
      const row = el('div', 'mrow');
      const face = el('span', 'mrow__icon');
      face.appendChild(icon('key', 16));
      const text = el('div', 'mrow__text');
      const top = el('div', 'mrow__top');
      top.append(el('span', 'mrow__name', token.label), el('span', 'mrow__tag', token.kind));
      text.append(top, el('span', 'mrow__sub', `Created ${tokenWhen(token.createdAt)} · last used ${tokenWhen(token.lastUsedAt)}`));
      const revoke = button('Revoke', 'btn btn--small btn--danger');
      revoke.addEventListener('click', () => {
        if (!window.confirm(`Revoke ${token.label}? Anything using it stops working at once.`)) return;
        void sendJson(`/api/tokens/${token.id}`, undefined, 'DELETE')
          .then(load)
          .catch((error: unknown) => toast(`Could not revoke ${token.label}: ${String(error)}`, 'error'));
      });
      const side = el('div', 'mrow__side');
      side.appendChild(revoke);
      row.append(face, text, side);
      return row;
    }));
  };

  function load(): void {
    void getJson<{ tokens: ApiTokenView[] }>('/api/tokens')
      .then((body) => { render(body.tokens); })
      .catch((error: unknown) => toast(`Could not read the API tokens: ${String(error)}`, 'error'));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!label.value.trim()) { toast('A token needs a label.', 'error'); label.focus(); return; }
    create.disabled = true;
    void sendJson<MintedApiToken>('/api/tokens', { kind: kind.value, label: label.value.trim() })
      .then((minted) => {
        if (!minted) return;
        reveal.show(minted.token);
        label.value = '';
        load();
      })
      .catch((error: unknown) => toast(`Could not create the token: ${String(error)}`, 'error'))
      .finally(() => { create.disabled = false; });
  });

  load();
  return pane;
}

/**
 * The GitHub connection and the one action that goes with it. Connect and Manage are plain
 * navigations (the hub's connect route redirects to GitHub); Disconnect only forgets the
 * installation here — the grant itself is removed on GitHub, which is what the confirmation says.
 * Connecting from scratch is also offered where the need arises, in New project (0034).
 */
function githubSection(): HTMLElement {
  const pane = el('section', 'msection');
  const box = el('div', 'mlist');
  const row = el('div', 'mrow');
  const face = el('span', 'mrow__icon');
  face.appendChild(icon('branch', 16));
  const text = el('div', 'mrow__text');
  const line = el('span', 'mrow__name', githubLineText(null).replace(/^GitHub: /, ''));
  text.append(line, el('span', 'mrow__sub', 'Imports repositories and pushes verified milestones back as a branch.'));
  const side = el('div', 'mrow__side');
  row.append(face, text, side);
  box.appendChild(row);
  pane.append(sectionHead('GitHub'), box);

  const load = (): void => {
    void getJson<GithubStatus>('/api/github/status')
      .then((status) => {
        const words = githubLineText(status).replace(/^GitHub: /, '');
        line.textContent = words.charAt(0).toUpperCase() + words.slice(1);
        side.replaceChildren();
        const installation = (status.installations ?? [])[0];
        if (installation) {
          const manage = el('a', 'btn btn--plain btn--small');
          manage.append(document.createTextNode('Manage on GitHub'), icon('external', 13));
          manage.href = installation.manageUrl;
          manage.target = '_blank';
          manage.rel = 'noreferrer';
          const drop = button('Disconnect', 'btn btn--small btn--danger');
          drop.addEventListener('click', () => {
            if (!window.confirm('Forget this GitHub connection? The app stays installed on GitHub until you remove it there.')) return;
            void sendJson(`/api/github/installations/${installation.id}`, undefined, 'DELETE')
              .then(() => { toast('GitHub disconnected.'); load(); })
              .catch((error: unknown) => toast(`Could not disconnect: ${String(error)}`, 'error'));
          });
          side.append(manage, drop);
        } else if (status.installUrl) {
          const start = button('Connect GitHub', 'btn btn--small');
          start.addEventListener('click', () => { window.location.assign(status.installUrl!); });
          side.appendChild(start);
        }
      })
      .catch(() => { /* a hub too old to know the route leaves the line reading… */ });
  };
  load();
  return pane;
}

/** Access: who and what may reach the hub — API tokens and the GitHub connection. */
export function mountAccess(host: HTMLElement, _store: Store): () => void {
  const page = el('div', 'msections');
  page.append(apiTokensSection(), githubSection());
  host.appendChild(page);
  return () => { page.remove(); };
}
