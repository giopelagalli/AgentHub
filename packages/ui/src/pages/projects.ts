import { AVATARS, PRIORITY_RANK, TEAM_ROLES, type ModelCatalog, type ModelPolicy, type Priority, type ProjectManifest, type TeamRoster } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { ARTIFACT_TITLES, docsSummary, prdSummary, roadmapSummary, type ArtifactId, type ArtifactSummary, type DocState } from '../artifacts.js';
import { avatarSvg } from '../avatars.js';
import type { DocsIndex } from '../docs.js';
import { button, el } from '../dom.js';
import { modelOptions, policyFromValue, policyPillText, valueFromPolicy, workerOptions, SAME_AS_ORCHESTRATOR } from '../models.js';
import { orgChartModel, type OrgCard, type OrgTier } from '../org.js';
import { openChat, type ChatActivity } from '../panels/chat.js';
import { openMasterPanel } from '../panels/master.js';
import { openSheet, type SheetHandle } from '../panels/sheet.js';
import type { PrdDoc } from '../prd.js';
import type { RoadmapDoc } from '../roadmap.js';
import type { Store, UiState } from '../store.js';
import { toast } from '../toast.js';
import { mountDocs } from '../views/docs.js';
import type { ViewContext } from '../views/parts.js';
import { mountPrd } from '../views/prd.js';
import { mountRoadmap } from '../views/roadmap.js';

export { button, el };

const PRIORITIES = Object.keys(PRIORITY_RANK) as Priority[];

/** What stands in for the employees tier while there is nobody to draw in it. */
const EMPLOYEES_EMPTY: Record<'loading' | 'ready' | 'failed', string> = {
  loading: 'Loading the team…',
  ready: 'No employees yet — Add employee hires one.',
  failed: 'The hub did not answer for this team.',
};

/**
 * Everything that decides what the project view looks like, short of the roster itself: which
 * project is selected, who's chatting, and each project's own fields — including `updatedAt`, so a
 * hire, a removal, or a turn (each of which touches a project without necessarily changing its
 * title, status or priority) still changes the signature and triggers a fresh render, a roster
 * reload and a re-read of the three artifacts.
 */
export function projectsSignature(state: UiState): string {
  const projects = state.hub?.projects ?? [];
  const current = projects.find((p) => p.slug === state.project);
  return [
    state.project,
    current?.updatedAt ?? '',
    [...state.projectBusy].sort().join(','),
    projects.map((p) => `${p.slug}:${p.title}:${p.status}:${p.priority}:${policyPillText(p.modelPolicy)}`).join('|'),
  ].join('~');
}

function selectBox(options: readonly string[], value: string): HTMLSelectElement {
  const box = el('select', 'select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option;
    item.textContent = option;
    box.appendChild(item);
  }
  box.value = value;
  return box;
}

/** The priority `<select>`, used by both this page's header and the allocation table. */
export function priorityPicker(slug: string, value: Priority): HTMLSelectElement {
  const box = selectBox(PRIORITIES, value);
  box.title = 'Priority';
  box.addEventListener('change', () => {
    const wanted = box.value as Priority;
    void sendJson(`/api/projects/${slug}/priority`, { priority: wanted })
      .then(() => toast(`${slug} is now ${wanted}.`))
      .catch((error: unknown) => {
        toast(`Could not set priority: ${String(error)}`, 'error');
        box.value = value;
      });
  });
  return box;
}

/**
 * The project's model policy: one `<select>` over everything `/api/models` lists, plus — once a
 * cloud provider is chosen — a second one that can give the worker tier a cheaper model. Both post
 * the whole policy, so the hub never has to merge a partial one.
 *
 * `currentPolicy` reads the manifest's *current* policy at post time (defaulting to the `policy`
 * this picker was rendered with) — the worker select's change handler uses it instead of closing
 * over the render-time `policy`, so a policy change made between render and that click (e.g. the
 * main select's own post still in flight) isn't clobbered by a stale orchestrator model.
 */
export function modelPicker(
  slug: string,
  policy: ModelPolicy | undefined,
  catalog: ModelCatalog | null,
  currentPolicy: () => ModelPolicy | undefined = () => policy,
): HTMLElement {
  const wrap = el('div', 'models');
  const post = (next: ModelPolicy, revert: () => void): void => {
    void sendJson(`/api/projects/${slug}/model`, next)
      .then(() => toast(`${slug} now runs on ${policyPillText(next)}.`))
      .catch((error: unknown) => {
        toast(`Could not set models: ${String(error)}`, 'error');
        revert();
      });
  };

  const main = el('select', 'select');
  const options = modelOptions(catalog);
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    main.appendChild(item);
  }
  const current = valueFromPolicy(policy);
  // The catalog can fail to load (or not include this policy's model any more) while the manifest
  // still names it — without this, `main.value = current` finds no matching option and the select
  // renders blank instead of showing what the project is actually on.
  if (!options.some((o) => o.value === current)) {
    const missing = document.createElement('option');
    missing.value = current;
    missing.textContent = policyPillText(policy);
    missing.disabled = true;
    main.appendChild(missing);
  }
  main.value = current;
  main.title = 'Models';
  main.addEventListener('change', () => post(policyFromValue(main.value), () => { main.value = current; }));
  wrap.appendChild(main);

  const provider = policy?.prefer === 'cloud' ? policy.provider : undefined;
  if (provider) {
    const worker = el('select', 'select');
    for (const option of workerOptions(catalog, provider)) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      worker.appendChild(item);
    }
    const workerCurrent = policy?.workerModel && policy.workerModel !== policy.orchestratorModel
      ? policy.workerModel
      : SAME_AS_ORCHESTRATOR;
    worker.value = workerCurrent;
    worker.title = 'Worker model';
    worker.addEventListener('change', () => {
      const live = currentPolicy();
      post({
        prefer: 'cloud', provider,
        ...(live?.orchestratorModel ? { orchestratorModel: live.orchestratorModel } : {}),
        ...(worker.value ? { workerModel: worker.value } : live?.orchestratorModel ? { workerModel: live.orchestratorModel } : {}),
      }, () => { worker.value = workerCurrent; });
    });
    wrap.appendChild(worker);
  }
  return wrap;
}

/** One org-chart card. Employees carry a remove button; the owner card isn't clickable. */
function orgCardNode(card: OrgCard, onOpen: (card: OrgCard) => void, onRemove: (card: OrgCard) => void): HTMLElement {
  const wrap = el('div', `card card--${card.kind}`);
  const face: HTMLElement = card.kind === 'owner' ? el('div', 'card__open') : button('', 'card__open');

  const portrait = el('span', 'card__avatar');
  if (card.avatar) portrait.appendChild(avatarSvg(card.avatar, 32));
  else portrait.textContent = 'YOU';
  face.appendChild(portrait);

  const text = el('span', 'card__text');
  text.append(el('span', 'card__name', card.name), el('span', 'card__role', card.role));
  if (card.reportsTo) text.appendChild(el('span', 'card__reports', `reports to: ${card.reportsTo}`));
  face.appendChild(text);

  if (card.status) {
    const dot = el('span', `dot dot--${card.status}`);
    dot.title = card.status;
    face.appendChild(dot);
  }

  if (card.kind !== 'owner') face.addEventListener('click', () => onOpen(card));
  wrap.appendChild(face);

  if (card.kind === 'employee') {
    const remove = button('×', 'card__remove');
    remove.title = `Remove ${card.name}`;
    remove.addEventListener('click', () => onRemove(card));
    wrap.appendChild(remove);
  }
  return wrap;
}

function orgTierNode(tier: OrgTier, onOpen: (card: OrgCard) => void, onRemove: (card: OrgCard) => void): HTMLElement {
  const group = el('div', tier.cards.length > 1 ? 'org__group org__group--rail' : 'org__group');
  const row = el('div', 'org__tier');
  for (const card of tier.cards) row.appendChild(orgCardNode(card, onOpen, onRemove));
  group.appendChild(row);
  return group;
}

/** The hire form: everything `POST /api/projects/:slug/team` needs, and nothing else. */
function hireForm(slug: string, onHired: () => void): HTMLFormElement {
  const form = el('form', 'hire');

  const name = el('input', 'input');
  name.placeholder = 'Name';
  name.required = true;
  const role = selectBox(TEAM_ROLES, TEAM_ROLES[0]);

  const picker = el('div', 'hire__avatars');
  let chosen: string = AVATARS[0];
  const choices = AVATARS.map((id) => {
    const choice = button('', 'hire__avatar');
    choice.title = id;
    choice.appendChild(avatarSvg(id, 32));
    choice.addEventListener('click', () => {
      chosen = id;
      for (const other of choices) other.removeAttribute('aria-pressed');
      choice.setAttribute('aria-pressed', 'true');
    });
    picker.appendChild(choice);
    return choice;
  });
  choices[0].setAttribute('aria-pressed', 'true');

  const instructions = el('textarea', 'input hire__instructions');
  instructions.placeholder = 'Standing instructions (optional)';
  instructions.rows = 3;

  const submit = el('button', 'btn btn--primary', 'Hire');
  submit.type = 'submit';
  const row = el('div', 'hire__row');
  row.append(name, role, submit);

  form.append(row, picker, instructions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const hired = name.value.trim();
    if (!hired) return;
    submit.disabled = true;
    void sendJson(`/api/projects/${slug}/team`, {
      name: hired,
      role: role.value,
      avatar: chosen,
      ...(instructions.value.trim() ? { instructions: instructions.value.trim() } : {}),
    })
      .then(() => {
        toast(`${hired} joined ${slug}.`);
        onHired();
      })
      .catch((error: unknown) => toast(`Could not hire: ${String(error)}`, 'error'))
      .finally(() => { submit.disabled = false; });
  });

  return form;
}


/** The three artifacts, each mounted into the sheet rather than into the page. */
const VIEWS: Record<ArtifactId, (host: HTMLElement, ctx: ViewContext, seed?: string[]) => () => void> = {
  prd: mountPrd,
  roadmap: mountRoadmap,
  docs: mountDocs,
};

/** One artifact's document, and where its fetch got to. */
interface Held<T> {
  state: DocState;
  doc: T | null;
}

/** One big button: the artifact's name, what state it is in, and its score where it has one. */
function artifactButton(summary: ArtifactSummary, open: (id: ArtifactId) => void): HTMLButtonElement {
  const node = button('', summary.filled ? 'artifact' : 'artifact artifact--empty');
  const top = el('div', 'artifact__top');
  top.appendChild(el('span', 'artifact__name', summary.label));
  if (summary.badge) top.appendChild(el('span', 'artifact__badge', summary.badge));
  node.append(top, el('span', 'artifact__caption', summary.caption), el('span', 'artifact__hint', summary.hint));
  node.addEventListener('click', () => open(summary.id));
  return node;
}

/**
 * The project view: the header, the three artifacts, and the org chart — which is the page's
 * permanent content, never swapped out for a document. PRD, Roadmap and Docs open over it in a
 * sheet, and a chat drawer opens either beside that sheet or, from an org-chart card, over the
 * page itself.
 */
export function mountProjects(host: HTMLElement, store: Store): () => void {
  const detail = el('section', 'detail');
  const headBox = el('header', 'detail__head');
  const artifactsBox = el('div', 'artifacts');
  const bodyBox = el('div', 'detail__body');
  detail.append(headBox, artifactsBox, bodyBox);
  host.appendChild(detail);

  /** One drawer at a time: a second would land on top of the first. */
  let closeDrawer: (() => void) | null = null;
  const openDrawer = (open: (into: HTMLElement) => () => void): void => {
    closeDrawer?.();
    closeDrawer = open(document.body);
  };

  let roster: TeamRoster | null = null;
  /** The model catalog, fetched once per mount; until it arrives the picker offers auto/local only. */
  let catalog: ModelCatalog | null = null;
  void getJson<ModelCatalog>('/api/models')
    .then((next) => { catalog = next; renderDetail(store.getState()); })
    .catch(() => { /* the picker still offers auto and local only */ });
  /** Why the employees tier is empty, when it is. */
  let rosterState: 'loading' | 'ready' | 'failed' = 'loading';
  let hiring = false;
  /** Bumped per fetch so a slow roster reply for a project we've left is dropped. */
  let rosterToken = 0;

  let prd: Held<PrdDoc> = { state: 'loading', doc: null };
  let roadmap: Held<RoadmapDoc> = { state: 'loading', doc: null };
  let docs: Held<DocsIndex> = { state: 'loading', doc: null };
  /** Bumped per artifact reload, so three slow replies for a project we've left are dropped. */
  let artifactToken = 0;

  /** The sheet, and the artifact currently mounted in it; both null while it is closed. */
  let sheet: SheetHandle | null = null;
  let sheetView: { id: ArtifactId; dispose: () => void } | null = null;

  const projectsOf = (state: UiState): ProjectManifest[] => state.hub?.projects ?? [];
  const selected = (state: UiState): ProjectManifest | null =>
    projectsOf(state).find((p) => p.slug === state.project) ?? null;

  const loadRoster = (slug: string): void => {
    const token = ++rosterToken;
    rosterState = 'loading';
    void getJson<TeamRoster>(`/api/projects/${slug}/team`)
      .then((next) => {
        if (token !== rosterToken) return;
        roster = next;
        rosterState = 'ready';
        renderDetail(store.getState());
      })
      .catch(() => {
        if (token !== rosterToken) return;
        roster = null;
        rosterState = 'failed';
        renderDetail(store.getState());
      });
  };

  /**
   * The three documents behind the three buttons. Each lands on its own, so one artifact the hub
   * can't answer for leaves the other two reading normally.
   */
  const loadArtifacts = (slug: string): void => {
    const token = ++artifactToken;
    const take = <T>(url: string, put: (held: Held<T>) => void): void => {
      void getJson<T>(url)
        .then((doc) => { if (token === artifactToken) { put({ state: 'ready', doc }); renderArtifacts(); } })
        .catch(() => { if (token === artifactToken) { put({ state: 'failed', doc: null }); renderArtifacts(); } });
    };
    take<PrdDoc>(`/api/projects/${slug}/prd`, (held) => { prd = held; });
    take<RoadmapDoc>(`/api/projects/${slug}/roadmap`, (held) => { roadmap = held; });
    take<DocsIndex>(`/api/projects/${slug}/docs`, (held) => { docs = held; });
  };

  const closeSheet = (): void => {
    sheet?.close();
  };

  /** Opens `id` in the sheet, reusing the one already on screen when there is one. */
  function openArtifact(id: ArtifactId, seed: string[] = []): void {
    const project = selected(store.getState());
    if (!project) return;
    if (!sheet) {
      sheet = openSheet(document.body, {
        onClose: () => {
          sheetView?.dispose();
          sheetView = null;
          sheet = null;
          // The writer may have changed the document while it was open.
          loadArtifacts(project.slug);
        },
      });
    }
    sheetView?.dispose();
    sheet.body.replaceChildren();
    sheet.setTitle(ARTIFACT_TITLES[id], project.title);
    const ctx: ViewContext = {
      slug: project.slug,
      title: project.title,
      openChat: (target) => sheet?.openChat(target),
      openArtifact: (next) => openArtifact(next),
    };
    sheetView = { id, dispose: VIEWS[id](sheet.body, ctx, seed) };
  }

  const openCard = (slug: string, card: OrgCard): void => {
    if (card.kind === 'assistant') {
      openDrawer((into) => openChat(into, {
        name: 'Assistant',
        subtitle: 'Your personal assistant',
        endpoint: '/api/assistant/messages',
        pendingBase: '/api/assistant/pending',
      }));
      return;
    }
    if (card.kind === 'master') {
      openDrawer((into) => openMasterPanel(into));
      return;
    }
    // The manager's "What they're doing" is the project's latest briefing; an employee's is their
    // roster entry (already loaded) plus their latest work session.
    const member = card.kind === 'employee' ? roster?.members.find((m) => m.id === card.id) : undefined;
    const activity: ChatActivity | undefined = card.kind === 'manager'
      ? { kind: 'manager', briefingUrl: `/api/projects/${slug}` }
      : member
        ? { kind: 'employee', member, activityUrl: `/api/projects/${slug}/team/${card.id}/activity` }
        : undefined;
    openDrawer((into) => openChat(into, {
      name: card.name,
      subtitle: `${card.role} · ${slug}`,
      endpoint: `/api/projects/${slug}/chat/${card.id}/messages`,
      historyEndpoint: `/api/projects/${slug}/chat/${card.id}`,
      ...(activity ? { activity } : {}),
    }));
  };

  const removeCard = (slug: string, card: OrgCard): void => {
    if (!confirm(`Remove ${card.name} from ${slug}?`)) return;
    void sendJson(`/api/projects/${slug}/team/${card.id}`, undefined, 'DELETE')
      .then(() => {
        toast(`${card.name} removed.`);
        loadRoster(slug);
      })
      .catch((error: unknown) => toast(`Could not remove: ${String(error)}`, 'error'));
  };

  /** The header row: what the project is, and the levers that apply to the whole of it. */
  function renderHead(project: ProjectManifest): void {
    headBox.replaceChildren();
    const line = el('div', 'detail__title');
    line.append(
      el('h1', undefined, project.title),
      el('span', `pill pill--${project.status}`, project.status),
      el('span', 'pill pill--models', policyPillText(project.modelPolicy)),
    );
    headBox.append(line, el('p', 'detail__intent', project.intent));

    const controls = el('div', 'actions');
    controls.appendChild(priorityPicker(project.slug, project.priority));
    controls.appendChild(modelPicker(
      project.slug, project.modelPolicy, catalog,
      () => selected(store.getState())?.modelPolicy,
    ));

    const paused = project.status === 'paused';
    const toggle = button(paused ? 'Resume' : 'Pause');
    toggle.addEventListener('click', () => {
      toggle.disabled = true;
      void sendJson(`/api/projects/${project.slug}/${paused ? 'resume' : 'pause'}`)
        .then(() => toast(`${project.title} ${paused ? 'resumed' : 'paused'}.`))
        .catch((error: unknown) => toast(`Could not ${paused ? 'resume' : 'pause'}: ${String(error)}`, 'error'))
        .finally(() => { toggle.disabled = false; });
    });

    const turn = button('Run turn', 'btn btn--primary');
    turn.addEventListener('click', () => {
      turn.disabled = true;
      turn.textContent = 'Running…';
      void sendJson<{ summary?: string }>(`/api/projects/${project.slug}/turn`)
        .then((briefing) => toast(briefing?.summary ?? 'Turn complete.'))
        .catch((error: unknown) => toast(`Turn failed: ${String(error)}`, 'error'))
        .finally(() => {
          turn.disabled = false;
          turn.textContent = 'Run turn';
          loadRoster(project.slug);
          loadArtifacts(project.slug);
        });
    });

    const hire = button(hiring ? 'Cancel' : 'Add employee');
    hire.addEventListener('click', () => {
      hiring = !hiring;
      renderDetail(store.getState());
    });

    controls.append(toggle, turn, hire);
    headBox.appendChild(controls);
    if (hiring) {
      headBox.appendChild(hireForm(project.slug, () => {
        hiring = false;
        loadRoster(project.slug);
      }));
    }
  }

  /** The three big buttons, redrawn whenever one of the documents behind them lands. */
  function renderArtifacts(): void {
    if (!selected(store.getState())) {
      artifactsBox.replaceChildren();
      return;
    }
    artifactsBox.replaceChildren(
      artifactButton(prdSummary(prd.state, prd.doc), openArtifact),
      artifactButton(roadmapSummary(roadmap.state, roadmap.doc), openArtifact),
      artifactButton(docsSummary(docs.state, docs.doc), openArtifact),
    );
  }

  /** The org chart: the permanent content of this page. */
  function orgChart(project: ProjectManifest, state: UiState): HTMLElement {
    const chatting = new Set(
      [...state.projectBusy]
        .filter((key) => key.startsWith(`${project.slug}:`))
        .map((key) => key.slice(project.slug.length + 1)),
    );
    const chart = el('div', 'org');
    for (const [index, tier] of orgChartModel(roster, chatting).entries()) {
      if (index > 0) chart.appendChild(el('div', 'org__link'));
      chart.appendChild(tier.cards.length
        ? orgTierNode(tier, (card) => openCard(project.slug, card), (card) => removeCard(project.slug, card))
        : el('p', 'empty', EMPLOYEES_EMPTY[rosterState]));
    }
    return chart;
  }

  function renderDetail(state: UiState): void {
    const project = selected(state);
    if (!project) {
      headBox.replaceChildren();
      artifactsBox.replaceChildren();
      bodyBox.replaceChildren(el(
        'p', 'empty',
        state.hub ? (state.project ? `Opening ${state.project}…` : 'No projects yet — New project starts one.') : 'Waiting for the hub…',
      ));
      return;
    }
    renderHead(project);
    renderArtifacts();
    bodyBox.replaceChildren(orgChart(project, state));
  }

  let last = '';
  let rosterFor: string | null = null;
  let rosterUpdatedAt: number | undefined;

  const render = (state: UiState): void => {
    const next = projectsSignature(state);
    if (next === last) return;
    last = next;

    const project = selected(state);
    const projectChanged = state.project !== rosterFor;
    // A card click opened the drawer for the project we were just looking at; switching projects
    // (arrow keys, the list, or the hub moving the selection) leaves it and any open sheet pointed
    // at the wrong project.
    if (projectChanged) {
      closeDrawer?.();
      closeDrawer = null;
      closeSheet();
    }
    if (projectChanged || project?.updatedAt !== rosterUpdatedAt) {
      rosterFor = state.project;
      rosterUpdatedAt = project?.updatedAt;
      if (projectChanged) {
        roster = null;
        rosterState = 'loading';
        hiring = false;
        prd = { state: 'loading', doc: null };
        roadmap = { state: 'loading', doc: null };
        docs = { state: 'loading', doc: null };
      }
      if (state.project) {
        loadRoster(state.project);
        loadArtifacts(state.project);
      }
    }
    renderDetail(state);
  };

  /**
   * A PRD the wizard has just drafted opens straight away, carrying the drafter's open questions;
   * taking the seed re-enters this listener with nothing left to take.
   */
  const takeSeed = (state: UiState): void => {
    const seed = state.prdSeed;
    if (!seed || seed.slug !== state.project) return;
    store.dispatch({ type: 'prd-seed-taken' });
    openArtifact('prd', seed.questions);
  };

  const unsubscribe = store.subscribe(render);
  const unseed = store.subscribe(takeSeed);
  render(store.getState());
  takeSeed(store.getState());

  return () => {
    unsubscribe();
    unseed();
    closeDrawer?.();
    closeSheet();
    rosterToken++;
    artifactToken++;
    detail.remove();
  };
}
