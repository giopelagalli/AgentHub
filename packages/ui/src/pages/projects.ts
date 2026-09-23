import { AVATARS, PRIORITY_RANK, TEAM_ROLES, type AutoRun, type ModelCatalog, type ModelPolicy, type Priority, type ProjectManifest, type TeamMemberView, type TeamRoster, type TeamStatus, type UsageReport } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import { ARTIFACT_TITLES, activitySummary, docsSummary, prdSummary, roadmapSummary, type ArtifactId, type ArtifactSummary, type DocState } from '../artifacts.js';
import { AUTO_RUN_INTERVALS, autoRunFromForm, autoRunLabel, budgetText, formatInterval } from '../autorun.js';
import { avatarSvg } from '../avatars.js';
import type { DocsIndex } from '../docs.js';
import { button, el } from '../dom.js';
import { memberModelOptions, modelOptions, policyFromValue, policyPillText, valueFromPolicy, workerOptions, SAME_AS_ORCHESTRATOR } from '../models.js';
import { orgChartModel, type OrgCard, type OrgTier } from '../org.js';
import { openChat, type ChatActivity } from '../panels/chat.js';
import { openMasterPanel } from '../panels/master.js';
import { openSheet, type SheetHandle } from '../panels/sheet.js';
import type { PrdDoc } from '../prd.js';
import type { RoadmapDoc } from '../roadmap.js';
import { turnsOf, type Store, type UiState } from '../store.js';
import { toast } from '../toast.js';
import { doingCaption, formatClock, formatUsd, openSubagents, runningTurn, type TurnRecord, type TurnsResponse } from '../turns.js';
import { mountActivity } from '../views/activity.js';
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
  const held = turnsOf(state, state.project);
  return [
    // Whether the hub has answered at all: with no projects the rest of this key is identical before
    // and after the first state frame, and the page would stay on 'Waiting for the hub…' forever.
    state.hub ? 'hub' : '',
    state.project,
    current?.updatedAt ?? '',
    [...state.projectBusy].sort().join(','),
    // A turn starting or ending redraws the header and the org chart; the events in between
    // only touch the captions, which `followTurn` updates in place. The budget fields change
    // the header's turns-left line without any turn starting or ending, so they're in here too.
    `${held.state}:${runningTurn(held.turns)?.sessionId ?? ''}:${held.turns[0]?.sessionId ?? ''}`
      + `:${held.budget?.usedToday ?? ''}:${held.budget?.hubUsedToday ?? ''}`,
    projects.map((p) => `${p.slug}:${p.title}:${p.status}:${p.priority}:${policyPillText(p.modelPolicy)}:${autoRunLabel(p.autoRun)}`).join('|'),
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

/** Human words for the hub's queue classes (`Priority`/`PRIORITY_RANK`) — which project's turns and jobs go first when nodes are busy. */
export const PRIORITY_LABELS: Record<Priority, string> = { interactive: 'Runs first', project: 'Normal', batch: 'When idle' };

export function priorityLabel(p: Priority): string {
  return PRIORITY_LABELS[p];
}

/** The priority `<select>`, used by both this page's header and the allocation table. */
export function priorityPicker(slug: string, value: Priority): HTMLSelectElement {
  const box = selectBox(PRIORITIES, value);
  for (const item of box.options) item.textContent = PRIORITY_LABELS[item.value as Priority];
  box.title = 'Order — which project\'s turns and jobs go first when nodes are busy';
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
    if (option.disabled) item.disabled = true;
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
      if (option.disabled) item.disabled = true;
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

/**
 * An employee's model override, shown above their chat log: "Project default" plus everything
 * `modelPicker` offers, posted to their own roster entry (`PATCH .../team/:id`) rather than the
 * project's. `null` on change clears it back to the project default.
 */
function memberModelField(slug: string, member: TeamMemberView, catalog: ModelCatalog | null): HTMLElement {
  const field = el('label', 'field');
  field.append(el('span', 'field__label', 'Model'));
  const select = el('select', 'select');
  for (const option of memberModelOptions(catalog)) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    if (option.disabled) item.disabled = true;
    select.appendChild(item);
  }
  const current = member.model ? valueFromPolicy(member.model) : '';
  select.value = current;
  select.addEventListener('change', () => {
    const next = select.value ? policyFromValue(select.value) : null;
    void sendJson(`/api/projects/${slug}/team/${member.id}`, { model: next }, 'PATCH')
      .then(() => toast(`${member.name} now runs on ${next ? policyPillText(next) : 'the project default'}.`))
      .catch((error: unknown) => {
        toast(`Could not set ${member.name}'s model: ${String(error)}`, 'error');
        select.value = current;
      });
  });
  field.appendChild(select);
  return field;
}

/** One org-chart card. Employees carry a remove button; the owner card isn't clickable. */
function orgCardNode(
  card: OrgCard, doing: string | null, rosterStatus: TeamStatus | null,
  onOpen: (card: OrgCard) => void, onRemove: (card: OrgCard) => void,
): HTMLElement {
  const wrap = el('div', `card card--${card.kind}`);
  wrap.dataset.who = card.id;
  // What the roster itself said, kept on the card so a subagent starting mid-turn can light the
  // dot in place and a subagent ending can hand it back to the roster's word.
  if (rosterStatus) wrap.dataset.status = rosterStatus;
  const face: HTMLElement = card.kind === 'owner' ? el('div', 'card__open') : button('', 'card__open');

  const portrait = el('span', 'card__avatar');
  if (card.avatar) portrait.appendChild(avatarSvg(card.avatar, 32));
  else portrait.textContent = 'YOU';
  face.appendChild(portrait);

  const text = el('span', 'card__text');
  text.append(el('span', 'card__name', card.name), el('span', 'card__role', card.role));
  if (card.reportsTo) text.appendChild(el('span', 'card__reports', `reports to: ${card.reportsTo}`));
  if (card.model) text.appendChild(el('span', 'pill pill--models', policyPillText(card.model)));
  // What the member is on right now, from the running turn; the line stays in the DOM (empty)
  // so an event can fill it in place without a re-render.
  if (card.kind === 'manager' || card.kind === 'employee') {
    const line = el('span', 'card__doing', doing ? `doing: ${doing}` : '');
    line.hidden = !doing;
    text.appendChild(line);
  }
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

function orgTierNode(
  tier: OrgTier, running: TurnRecord | null, statusOf: (id: string) => TeamStatus | null,
  onOpen: (card: OrgCard) => void, onRemove: (card: OrgCard) => void,
): HTMLElement {
  const group = el('div', tier.cards.length > 1 ? 'org__group org__group--rail' : 'org__group');
  const row = el('div', 'org__tier');
  for (const card of tier.cards) {
    row.appendChild(orgCardNode(card, doingCaption(running, card.id), statusOf(card.id), onOpen, onRemove));
  }
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

/** The auto-run form: `POST /api/projects/:slug/autorun`'s body, and nothing else. */
function autoRunForm(
  slug: string, title: string, current: AutoRun | undefined, onSaved: () => void, onCancel: () => void,
): HTMLFormElement {
  const form = el('form', 'hire');

  const enabledLabel = el('label', 'hire__row');
  const enabled = el('input') as HTMLInputElement;
  enabled.type = 'checkbox';
  enabled.checked = current?.enabled ?? false;
  enabledLabel.append(enabled, document.createTextNode('Run turns on a schedule'));

  const interval = el('select', 'select');
  for (const minutes of AUTO_RUN_INTERVALS) {
    const item = document.createElement('option');
    item.value = String(minutes);
    item.textContent = formatInterval(minutes);
    interval.appendChild(item);
  }
  interval.value = String(current?.everyMinutes ?? 60);
  interval.title = 'How often a turn starts on its own';

  const maxPerDay = el('input', 'input') as HTMLInputElement;
  maxPerDay.type = 'number';
  maxPerDay.min = '1';
  maxPerDay.max = '100';
  maxPerDay.value = String(current?.maxTurnsPerDay ?? 6);
  maxPerDay.title = 'Daily cap for this project; the hub has its own cap too';

  const submit = el('button', 'btn btn--primary', 'Save');
  submit.type = 'submit';
  const cancel = button('Cancel');
  cancel.addEventListener('click', onCancel);

  const row = el('div', 'hire__row');
  row.append(
    document.createTextNode('Every '), interval,
    document.createTextNode(', at most '), maxPerDay,
    document.createTextNode(' turns a day'),
    submit, cancel,
  );

  form.append(enabledLabel, row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const autoRun = autoRunFromForm({ enabled: enabled.checked, everyMinutes: interval.value, maxTurnsPerDay: maxPerDay.value });
    if (!autoRun) {
      toast('Pick an interval and a 1–100 daily cap.', 'error');
      return;
    }
    submit.disabled = true;
    void sendJson(`/api/projects/${slug}/autorun`, autoRun)
      .then(() => {
        toast(`${title}: ${autoRunLabel(autoRun)}`);
        onSaved();
      })
      .catch((error: unknown) => toast(`Could not set auto-run: ${String(error)}`, 'error'))
      .finally(() => { submit.disabled = false; });
  });

  return form;
}

/** The three documents, each mounted into the sheet rather than into the page. */
const DOC_VIEWS: Record<Exclude<ArtifactId, 'activity'>, (host: HTMLElement, ctx: ViewContext, seed?: string[]) => () => void> = {
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
  const node = button('', `artifact${summary.filled ? '' : ' artifact--empty'}${summary.live ? ' artifact--live' : ''}`);
  node.dataset.artifact = summary.id;
  const top = el('div', 'artifact__top');
  top.appendChild(el('span', 'artifact__name', summary.label));
  if (summary.badge) top.appendChild(el('span', 'artifact__badge', summary.badge));
  if (summary.live) top.appendChild(el('span', 'artifact__live', 'live'));
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
  /** The thin line under the header that lights with each event while a turn runs. */
  const progress = el('div', 'progress');
  progress.hidden = true;
  const artifactsBox = el('div', 'artifacts');
  const bodyBox = el('div', 'detail__body');
  detail.append(headBox, progress, artifactsBox, bodyBox);
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
  let autoRunEditing = false;
  /** Bumped per fetch so a slow roster reply for a project we've left is dropped. */
  let rosterToken = 0;

  let prd: Held<PrdDoc> = { state: 'loading', doc: null };
  let roadmap: Held<RoadmapDoc> = { state: 'loading', doc: null };
  let docs: Held<DocsIndex> = { state: 'loading', doc: null };
  /** Bumped per artifact reload, so three slow replies for a project we've left are dropped. */
  let artifactToken = 0;

  /** The Run turn button on screen, so the clock can tick on it without a re-render. */
  let turnButton: HTMLButtonElement | null = null;
  /** How many events of the running turn the captions have seen; null while none runs. */
  let followedEvents: number | null = null;
  /** The last turn whose end was toasted, so the POST reply and the socket don't both say it. */
  let toastedEnd: number | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

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

  /** Each project's trailing-24h spend, as the header chip shows it; empty until a fetch lands. */
  const costToday = new Map<string, number>();
  const costText = (slug: string): string => {
    const usd = costToday.get(slug);
    return usd ? `${formatUsd(usd)} today` : '—';
  };

  /**
   * What this project has cost in the last 24 hours. Fetched with the turns rather than on its own
   * schedule — a turn ending is the only thing that moves it — and written into the chip in place,
   * so a landing fetch never redraws the header under the owner's typing.
   */
  const loadCost = (slug: string): void => {
    void getJson<UsageReport>(`/api/usage/summary?project=${encodeURIComponent(slug)}`)
      .then((report) => {
        costToday.set(slug, report.usd);
        if (store.getState().project !== slug) return;
        const chip = headBox.querySelector<HTMLElement>('.detail__cost');
        if (chip) chip.textContent = costText(slug);
      })
      .catch(() => { /* the chip stays as it was; the turns list already reports a dead hub */ });
  };

  /** The recent turns, and with them whether one is running right now. Lands in the store. */
  const loadTurns = (slug: string): void => {
    loadCost(slug);
    void getJson<TurnsResponse>(`/api/projects/${slug}/turns`)
      .then((response) => store.dispatch({ type: 'turns-loaded', slug, response }))
      .catch(() => store.dispatch({ type: 'turns-failed', slug }));
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
    sheet.setLayout(id === 'activity' ? 'wide' : 'document');
    const ctx: ViewContext = {
      slug: project.slug,
      title: project.title,
      openChat: (target) => sheet?.openChat(target),
      openArtifact: (next) => openArtifact(next),
    };
    const dispose = id === 'activity'
      ? mountActivity(sheet.body, ctx, { store, roster: () => roster })
      : DOC_VIEWS[id](sheet.body, ctx, seed);
    sheetView = { id, dispose };
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
    // The Now section reads the running turn straight out of the store, under the same `who` the
    // turn events carry. The idle line behind it is the project's latest briefing for the manager,
    // and the member's latest work session for an employee.
    const member = card.kind === 'employee' ? roster?.members.find((m) => m.id === card.id) : undefined;
    const now = { store, slug, who: card.id };
    const activity: ChatActivity | undefined = card.kind === 'manager'
      ? { kind: 'manager', briefingUrl: `/api/projects/${slug}`, now }
      : member
        ? {
          kind: 'employee',
          member,
          activityUrl: `/api/projects/${slug}/team/${card.id}/activity`,
          now: { ...now, meta: `${member.sessionsCount} session${member.sessionsCount === 1 ? '' : 's'}` },
        }
        : undefined;
    openDrawer((into) => openChat(into, {
      name: card.name,
      subtitle: `${card.role} · ${slug}`,
      endpoint: `/api/projects/${slug}/chat/${card.id}/messages`,
      historyEndpoint: `/api/projects/${slug}/chat/${card.id}`,
      ...(activity ? { activity } : {}),
      ...(member ? { modelField: memberModelField(slug, member, catalog) } : {}),
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
    const priorityField = el('label', 'field');
    priorityField.append(el('span', 'field__label', 'Order'), priorityPicker(project.slug, project.priority));
    controls.appendChild(priorityField);
    controls.appendChild(modelPicker(
      project.slug, project.modelPolicy, catalog,
      () => selected(store.getState())?.modelPolicy,
    ));

    const autoRunToggle = button(autoRunLabel(project.autoRun));
    autoRunToggle.addEventListener('click', () => {
      autoRunEditing = !autoRunEditing;
      renderDetail(store.getState());
    });
    controls.appendChild(autoRunToggle);
    controls.appendChild(el('span', 'detail__budget', budgetText(turnsOf(store.getState(), project.slug).budget)));
    controls.appendChild(el('span', 'detail__cost', costText(project.slug)));

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
    const running = runningTurn(turnsOf(store.getState(), project.slug).turns);
    if (running) {
      turn.disabled = true;
      turn.textContent = `Running · ${formatClock(Date.now() - running.startedAt)}`;
    }
    turn.addEventListener('click', () => {
      turn.disabled = true;
      turn.textContent = 'Running…';
      void sendJson<{ summary?: string }>(`/api/projects/${project.slug}/turn`)
        .then((briefing) => {
          // The socket's turn-end usually said it first; a hub without turn events still gets a toast.
          const ended = turnsOf(store.getState(), project.slug).turns[0];
          if (!ended || toastedEnd !== ended.sessionId) toast(briefing?.summary ?? 'Turn complete.');
        })
        .catch((error: unknown) => toast(`Turn failed: ${String(error)}`, 'error'))
        .finally(() => {
          if (!runningTurn(turnsOf(store.getState(), project.slug).turns)) {
            turn.disabled = false;
            turn.textContent = 'Run turn';
          }
          loadRoster(project.slug);
          loadArtifacts(project.slug);
          loadTurns(project.slug);
        });
    });
    turnButton = turn;

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
    if (autoRunEditing) {
      headBox.appendChild(autoRunForm(
        project.slug, project.title, project.autoRun,
        () => {
          autoRunEditing = false;
          loadTurns(project.slug);
          renderDetail(store.getState());
        },
        () => {
          autoRunEditing = false;
          renderDetail(store.getState());
        },
      ));
    }
  }

  /** The three big buttons, redrawn whenever one of the documents behind them lands. */
  function renderArtifacts(): void {
    if (!selected(store.getState())) {
      artifactsBox.replaceChildren();
      return;
    }
    const state = store.getState();
    const held = turnsOf(state, state.project);
    artifactsBox.replaceChildren(
      artifactButton(prdSummary(prd.state, prd.doc), openArtifact),
      artifactButton(roadmapSummary(roadmap.state, roadmap.doc), openArtifact),
      artifactButton(docsSummary(docs.state, docs.doc), openArtifact),
      artifactButton(activitySummary(held.state, held.turns, roster, Date.now()), openArtifact),
    );
  }

  /**
   * The parts of the page that move while a turn runs, changed in place rather than redrawn: the
   * clock on the Run turn button, the Activity hint, the "doing:" line on each card, and the
   * progress line, which lights for a moment on each event. A redraw here would also rebuild the
   * hire form under the owner's typing.
   */
  function followTurn(state: UiState): void {
    const slug = state.project;
    if (!slug) return;
    const held = turnsOf(state, slug);
    const running = runningTurn(held.turns);
    progress.hidden = !running;

    if (turnButton && running) {
      turnButton.disabled = true;
      turnButton.textContent = `Running · ${formatClock(Date.now() - running.startedAt)}`;
    }
    const hint = artifactsBox.querySelector<HTMLElement>('[data-artifact="activity"] .artifact__hint');
    if (hint) hint.textContent = activitySummary(held.state, held.turns, roster, Date.now()).hint;

    const seen = running ? running.events.length : null;
    if (seen === followedEvents) return;
    followedEvents = seen;
    if (!running) return;

    const open = new Set(openSubagents(running));
    for (const card of bodyBox.querySelectorAll<HTMLElement>('.card[data-who]')) {
      const who = card.dataset.who ?? '';
      const line = card.querySelector<HTMLElement>('.card__doing');
      if (!line) continue;
      const doing = doingCaption(running, who);
      line.textContent = doing ? `doing: ${doing}` : '';
      line.hidden = !doing;
      const working = card.dataset.status === 'working' || open.has(who) || who === 'manager';
      card.querySelector('.dot')?.classList.toggle('dot--working', working);
    }
    progress.classList.add('progress--lit');
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => progress.classList.remove('progress--lit'), 350);
  }

  /** A turn that ended under the socket: the toast, and the documents it may have changed. */
  function onTurnEnded(state: UiState): void {
    const slug = state.project;
    if (!slug) return;
    const newest = turnsOf(state, slug).turns[0];
    if (!newest || newest.endedAt === null || toastedEnd === newest.sessionId) return;
    // Only a turn that ended while we were watching gets announced; history is not news.
    if (followedEvents === null) return;
    toastedEnd = newest.sessionId;
    toast(newest.summary || `Turn ${newest.outcome ?? 'ended'}.`);
    loadRoster(slug);
    loadArtifacts(slug);
  }

  /** The org chart: the permanent content of this page. */
  function orgChart(project: ProjectManifest, state: UiState): HTMLElement {
    const chatting = new Set(
      [...state.projectBusy]
        .filter((key) => key.startsWith(`${project.slug}:`))
        .map((key) => key.slice(project.slug.length + 1)),
    );
    const chart = el('div', 'org');
    const running = runningTurn(turnsOf(state, project.slug).turns);
    // A subagent the turn has open is working whatever the roster last said; so is the manager.
    if (running) for (const who of ['manager', ...openSubagents(running)]) chatting.add(who);
    const statusOf = (id: string): TeamStatus | null =>
      id === 'manager' ? (roster?.manager.status ?? null) : (roster?.members.find((m) => m.id === id)?.status ?? null);
    for (const [index, tier] of orgChartModel(roster, chatting).entries()) {
      if (index > 0) chart.appendChild(el('div', 'org__link'));
      chart.appendChild(tier.cards.length
        ? orgTierNode(tier, running, statusOf, (card) => openCard(project.slug, card), (card) => removeCard(project.slug, card))
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
    progress.hidden = !runningTurn(turnsOf(state, project.slug).turns);
  }

  let last = '';
  let rosterFor: string | null = null;
  let rosterUpdatedAt: number | undefined;

  const render = (state: UiState): void => {
    const next = projectsSignature(state);
    if (next === last) {
      followTurn(state);
      return;
    }
    last = next;
    onTurnEnded(state);

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
        autoRunEditing = false;
        followedEvents = null;
        toastedEnd = null;
        prd = { state: 'loading', doc: null };
        roadmap = { state: 'loading', doc: null };
        docs = { state: 'loading', doc: null };
      }
      if (state.project) {
        loadRoster(state.project);
        loadArtifacts(state.project);
        if (projectChanged) loadTurns(state.project);
      }
    }
    renderDetail(state);
    followTurn(state);
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
  /** The Run turn clock and the Activity hint's elapsed time, once a second while a turn runs. */
  const clock = setInterval(() => {
    if (runningTurn(turnsOf(store.getState(), store.getState().project).turns)) followTurn(store.getState());
  }, 1000);

  return () => {
    unsubscribe();
    unseed();
    clearInterval(clock);
    clearTimeout(progressTimer);
    closeDrawer?.();
    closeSheet();
    rosterToken++;
    artifactToken++;
    detail.remove();
  };
}
