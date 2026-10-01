import type { HarnessInfo, ModelCatalog, PreviewStatus, ProjectManifest, TeamRoster, UsageReport } from '@agenthub/shared';
import { getJson, sendJson } from '../api.js';
import type { ArtifactId } from '../artifacts.js';
import { autoRunLabel } from '../autorun.js';
import type { CodeSummaryDoc } from '../code/model.js';
import type { DocsIndex } from '../docs.js';
import { button, el } from '../dom.js';
import { menuButton, type MenuEntry } from '../menu.js';
import { policyPillText } from '../models.js';
import { orgChartModel, type OrgCard } from '../org.js';
import { PROJECT_TABS, TAB_LABELS, type CodePart, type PlanPart, type ProjectTab } from '../overview.js';
import { openChat, type ChatActivity, type ChatTarget } from '../panels/chat.js';
import { openMasterPanel, type Briefing } from '../panels/master.js';
import { sourceHref } from '../panels/source.js';
import { openProjectWizard } from '../panels/wizard.js';
import type { PrdDoc } from '../prd.js';
import { DOT_WORDS, openNewProject, projectDot } from '../rail.js';
import type { RoadmapDoc } from '../roadmap.js';
import { turnsOf, type Store, type UiState } from '../store.js';
import { toast } from '../toast.js';
import { iconButton, segmented, toolbar } from '../toolbar.js';
import { formatClock, formatUsd, runningTurn, type TurnsResponse } from '../turns.js';
import { mountActivity } from '../views/activity.js';
import { mountCode } from '../views/code.js';
import { mountDocs } from '../views/docs.js';
import type { ViewContext } from '../views/parts.js';
import { mountPrd } from '../views/prd.js';
import { mountPreview } from '../views/preview.js';
import { mountRoadmap } from '../views/roadmap.js';
import { mountTerminal } from '../views/terminal.js';
import { fillHarnessField, memberModelField } from './project/controls.js';
import { renderOverview, tickOverview, type Held, type OverviewData } from './project/overview.js';
import { openProjectSettings, type SettingsHandle, type SettingsSection } from './project/settings.js';

export { button, el };
export { PRIORITY_LABELS, priorityLabel, priorityPicker } from './project/controls.js';

/**
 * Everything that decides what the project page's frame looks like: which project is selected,
 * who's chatting, and each project's own fields — including `updatedAt`, so a hire, a removal, or a
 * turn (each of which touches a project without necessarily changing its title, status or
 * priority) still changes the signature and triggers a roster reload and a re-read of the
 * documents the Overview summarises.
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
    // A turn starting or ending redraws the toolbar and the Overview; the events in between only
    // touch what `followTurn` updates. The budget fields change the settings sheet's turns-left
    // line without any turn starting or ending, so they're in here too.
    `${held.state}:${runningTurn(held.turns)?.sessionId ?? ''}:${held.turns[0]?.sessionId ?? ''}`
      + `:${held.budget?.usedToday ?? ''}:${held.budget?.hubUsedToday ?? ''}`,
    projects.map((p) => `${p.slug}:${p.title}:${p.status}:${p.priority}:${policyPillText(p.modelPolicy)}:${autoRunLabel(p.autoRun)}`).join('|'),
  ].join('~');
}

/**
 * The manager's card, taken from the org chart rather than written out again, so the toolbar's
 * Chat button opens exactly what clicking the Manager on the Overview opens. Undefined would mean
 * the chart no longer has a manager tier, which the toolbar reads as nothing to chat to.
 */
export function managerCard(roster: TeamRoster | null): OrgCard | undefined {
  return orgChartModel(roster).flatMap((tier) => tier.cards).find((card) => card.kind === 'manager');
}

/** Where each old artifact lives now: a tab, and inside Plan and Code, a part of it. */
const ARTIFACT_PLACES: Record<ArtifactId, [ProjectTab, (PlanPart | CodePart)?]> = {
  prd: ['plan', 'prd'],
  roadmap: ['plan', 'roadmap'],
  docs: ['docs'],
  activity: ['activity'],
  code: ['code', 'files'],
  terminal: ['code', 'terminal'],
  preview: ['code', 'preview'],
};

const PLAN_PARTS = [{ id: 'prd', label: 'Requirements' }, { id: 'roadmap', label: 'Roadmap' }] as const;
const CODE_PARTS = [{ id: 'files', label: 'Files' }, { id: 'terminal', label: 'Terminal' }, { id: 'preview', label: 'Preview' }] as const;

/** The tab and parts last looked at, kept across projects (and visits to Machines) for this session. */
let lastTab: ProjectTab = 'overview';
let lastPlan: PlanPart = 'prd';
let lastCode: CodePart = 'files';

const loading = <T>(): Held<T> => ({ state: 'loading', doc: null });

/**
 * The project page: a toolbar (the project, its five sections, Chat, the one primary action and
 * `⋯`), and under it the section on screen. A chat about a document opens in a pane beside it;
 * a team member's drawer slides in over the page.
 */
export function mountProjects(host: HTMLElement, store: Store): () => void {
  const view = el('div', 'view project');
  const bar = toolbar();
  const titleNode = el('h1', 'toolbar__title');
  const titleDot = el('span', 'dot');
  bar.leading.append(titleNode, titleDot);

  const tabs = segmented(
    PROJECT_TABS.map((id) => ({ id, label: TAB_LABELS[id] })),
    lastTab,
    (id) => setTab(id),
    'Project sections',
  );
  bar.center.appendChild(tabs.root);

  const chatButton = iconButton('chat', 'Chat with the Manager (c)');
  const turnButton = button('', 'btn btn--primary project__run');
  const moreButton = iconButton('more', 'More');
  bar.trailing.append(chatButton, turnButton, moreButton);

  /** The thin line under the toolbar that lights with each event while a turn runs. */
  const progress = el('div', 'progress');
  progress.hidden = true;
  bar.root.appendChild(progress);

  const body = el('div', 'view__body');
  const pane = el('aside', 'project__pane');
  pane.hidden = true;
  view.append(bar.root, body, pane);
  host.appendChild(view);

  // --- data ----------------------------------------------------------------------------------

  const projectsOf = (state: UiState): ProjectManifest[] => state.hub?.projects ?? [];
  const selected = (state: UiState = store.getState()): ProjectManifest | null =>
    projectsOf(state).find((p) => p.slug === state.project) ?? null;

  let roster: TeamRoster | null = null;
  let rosterState: 'loading' | 'ready' | 'failed' = 'loading';
  /** Bumped per fetch so a slow roster reply for a project we've left is dropped. */
  let rosterToken = 0;
  /** The model catalog, fetched once per mount; until it arrives the pickers offer auto/local only. */
  let catalog: ModelCatalog | null = null;
  void getJson<ModelCatalog>('/api/models')
    .then((next) => { catalog = next; settings?.refresh(); })
    .catch(() => { /* the picker still offers auto and local only */ });
  /** Which harnesses this hub can run, fetched once per mount; until it answers, none are offered. */
  let harnesses: HarnessInfo[] = [];
  /** An open employee drawer's Harness slot, filled again once the list lands. */
  let harnessSlot: { slot: HTMLElement; slug: string; memberId: string } | null = null;
  void getJson<HarnessInfo[]>('/api/harnesses')
    .then((next) => {
      harnesses = next;
      const open = harnessSlot;
      const member = open ? roster?.members.find((m) => m.id === open.memberId) : undefined;
      if (open && member) fillHarnessField(open.slot, open.slug, member, harnesses);
    })
    .catch(() => { /* the drawer simply shows no Harness field */ });

  let prd: Held<PrdDoc> = loading();
  let roadmap: Held<RoadmapDoc> = loading();
  let docs: Held<DocsIndex> = loading();
  let preview: Held<PreviewStatus> = loading();
  let code: Held<CodeSummaryDoc> = loading();
  let briefing: Held<Briefing> = loading();
  /** Bumped per reload, so slow replies for a project we've left are dropped. */
  let artifactToken = 0;

  /** Each project's trailing-24h spend; absent until a fetch lands. */
  const costToday = new Map<string, number>();
  const costText = (slug: string): string => {
    const usd = costToday.get(slug);
    return usd ? `${formatUsd(usd)} today` : '';
  };

  const loadRoster = (slug: string): Promise<void> => {
    const token = ++rosterToken;
    return getJson<TeamRoster>(`/api/projects/${slug}/team`)
      .then((next) => {
        if (token !== rosterToken) return;
        roster = next;
        rosterState = 'ready';
        drawOverview();
      })
      .catch(() => {
        if (token !== rosterToken) return;
        roster = null;
        rosterState = 'failed';
        drawOverview();
      });
  };

  /** The documents the Overview summarises. Each lands on its own, so one the hub can't answer for leaves the rest reading normally. */
  const loadArtifacts = (slug: string): void => {
    const token = ++artifactToken;
    const take = <T>(url: string, put: (held: Held<T>) => void, pick: (body: unknown) => T = (b) => b as T): void => {
      void getJson<unknown>(url)
        .then((doc) => { if (token === artifactToken) { put({ state: 'ready', doc: pick(doc) }); drawOverview(); } })
        .catch(() => { if (token === artifactToken) { put({ state: 'failed', doc: null }); drawOverview(); } });
    };
    take<PrdDoc>(`/api/projects/${slug}/prd`, (held) => { prd = held; });
    take<RoadmapDoc>(`/api/projects/${slug}/roadmap`, (held) => { roadmap = held; });
    take<DocsIndex>(`/api/projects/${slug}/docs`, (held) => { docs = held; });
    take<PreviewStatus>(`/api/projects/${slug}/preview`, (held) => { preview = held; });
    take<CodeSummaryDoc>(`/api/projects/${slug}/code`, (held) => { code = held; });
    take<Briefing>(`/api/projects/${slug}`, (held) => { briefing = held; }, (b) => (b as { briefing: Briefing | null }).briefing as Briefing);
  };

  /** What this project has cost in the last 24 hours; fetched with the turns, since only a turn moves it. */
  const loadCost = (slug: string): void => {
    void getJson<UsageReport>(`/api/usage/summary?project=${encodeURIComponent(slug)}`)
      .then((report) => {
        costToday.set(slug, report.usd);
        if (store.getState().project === slug) { drawOverview(); settings?.refresh(); }
      })
      .catch(() => { /* the line stays as it was; the turns list already reports a dead hub */ });
  };

  /** The recent turns, and with them whether one is running right now. Lands in the store. */
  const loadTurns = (slug: string): void => {
    loadCost(slug);
    void getJson<TurnsResponse>(`/api/projects/${slug}/turns`)
      .then((response) => store.dispatch({ type: 'turns-loaded', slug, response }))
      .catch(() => store.dispatch({ type: 'turns-failed', slug }));
  };

  // --- the drawer: one team member's panel, over the page ------------------------------------

  /** One drawer at a time: a second would land on top of the first. */
  let closeDrawer: (() => void) | null = null;
  /** The card id the open drawer belongs to, so the toolbar can light what is open; null while none is. */
  let drawerFor: string | null = null;
  const syncChatButton = (): void => {
    chatButton.setAttribute('aria-pressed', String(drawerFor === 'manager'));
  };
  const openDrawer = (who: string, open: (into: HTMLElement) => () => void): void => {
    // Closing the old one first fires its `onClose`, which clears `drawerFor` — hence the order here.
    closeDrawer?.();
    closeDrawer = open(document.body);
    drawerFor = who;
    syncChatButton();
  };
  /** The drawer has gone, whichever way it was closed; nothing is left to call a second time. */
  const onDrawerClosed = (): void => {
    closeDrawer = null;
    drawerFor = null;
    harnessSlot = null;
    syncChatButton();
  };

  const openCard = (card: OrgCard): void => {
    const project = selected();
    if (!project) return;
    const slug = project.slug;
    if (card.kind === 'assistant') {
      openDrawer(card.id, (into) => openChat(into, {
        name: 'Assistant',
        subtitle: 'Your personal assistant',
        endpoint: '/api/assistant/messages',
        pendingBase: '/api/assistant/pending',
        onClose: onDrawerClosed,
        ...(card.avatar ? { avatar: card.avatar } : {}),
      }));
      return;
    }
    if (card.kind === 'master') {
      openDrawer(card.id, (into) => openMasterPanel(into, { onClose: onDrawerClosed }));
      return;
    }
    if (card.kind === 'owner') return;
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
    const slot = el('div', 'drawer__harness');
    slot.hidden = true;
    if (member) fillHarnessField(slot, slug, member, harnesses);
    openDrawer(card.id, (into) => openChat(into, {
      name: card.name,
      subtitle: card.kind === 'manager' ? `Manager · ${project.title}` : `${card.role} · ${project.title}`,
      endpoint: `/api/projects/${slug}/chat/${card.id}/messages`,
      historyEndpoint: `/api/projects/${slug}/chat/${card.id}`,
      onClose: onDrawerClosed,
      ...(card.avatar ? { avatar: card.avatar } : {}),
      ...(activity ? { activity } : {}),
      ...(member ? { modelField: memberModelField(slug, member, catalog), harnessField: slot } : {}),
    }));
    if (member) harnessSlot = { slot, slug, memberId: member.id };
  };

  /** Whether the keyboard currently belongs to an open drawer rather than to the page. */
  const focusInDrawer = (): boolean => {
    const active = document.activeElement;
    return active instanceof HTMLElement && !!active.closest('body > .drawer');
  };

  /**
   * The toolbar's way into the manager's drawer: the same drawer the Manager on the Overview opens.
   *
   * What a second press does depends on where it came from. `fromDrawer` — from inside the
   * conversation — closes it, which is what the button's pressed state promises. From anywhere else
   * it puts the cursor back in the message box, rather than rebuilding the conversation or tearing
   * it down under someone who only meant to reach it.
   *
   * A running turn is no reason to hold this back — the hub answers a one-on-one with the manager
   * alongside the turn, and anything it does refuse arrives in the log as a failed reply.
   */
  const openManagerChat = (fromDrawer: boolean): void => {
    if (!selected()) return;
    if (drawerFor === 'manager') {
      if (fromDrawer) {
        closeDrawer?.();
        return;
      }
      document.querySelector<HTMLInputElement>('body > .drawer .chat__form input')?.focus();
      return;
    }
    const card = managerCard(roster);
    if (card) openCard(card);
  };

  // Some browsers focus a button on press, so where focus was is read before that happens: it is
  // what separates a press from inside the conversation from one reaching for it off the page.
  let pressedFromDrawer = false;
  chatButton.addEventListener('pointerdown', () => { pressedFromDrawer = focusInDrawer(); });
  chatButton.addEventListener('click', () => {
    openManagerChat(pressedFromDrawer);
    pressedFromDrawer = false;
  });

  // --- the pane: a conversation about the document beside it ---------------------------------

  let closePane: (() => void) | null = null;
  let paneEndpoint: string | null = null;
  const dropPane = (): void => {
    closePane = null;
    paneEndpoint = null;
    pane.hidden = true;
    pane.replaceChildren();
    view.classList.remove('project--pane');
  };
  /** Opens `target` in the pane; asking for the conversation already open closes it instead. */
  const openPane = (target: ChatTarget): void => {
    if (paneEndpoint === target.endpoint && closePane) {
      closePane();
      return;
    }
    closePane?.();
    pane.hidden = false;
    view.classList.add('project--pane');
    paneEndpoint = target.endpoint;
    closePane = openChat(pane, { ...target, onClose: () => { target.onClose?.(); dropPane(); } });
  };

  // --- the settings sheet --------------------------------------------------------------------

  let settings: SettingsHandle | null = null;
  const openSettings = (section?: SettingsSection): void => {
    const project = selected();
    if (!project) return;
    settings?.close();
    const slug = project.slug;
    const handle = openProjectSettings(document.body, {
      project: () => projectsOf(store.getState()).find((p) => p.slug === slug) ?? null,
      catalog: () => catalog,
      roster: () => roster,
      budget: () => turnsOf(store.getState(), slug).budget,
      cost: () => costText(slug),
      onTeamChanged: () => loadRoster(slug),
      onScheduleChanged: () => loadTurns(slug),
      onClose: () => { if (settings === handle) settings = null; },
      ...(section ? { section } : {}),
    });
    settings = handle;
  };

  // --- running a turn ------------------------------------------------------------------------

  /** The last turn whose end was toasted, so the POST reply and the socket don't both say it. */
  let toastedEnd: number | null = null;
  let starting = false;

  const runTurn = (): void => {
    const project = selected();
    if (!project || starting || runningTurn(turnsOf(store.getState(), project.slug).turns)) return;
    const slug = project.slug;
    starting = true;
    drawTurnButton();
    void sendJson<{ summary?: string }>(`/api/projects/${slug}/turn`)
      .then((result) => {
        // The socket's turn-end usually said it first; a hub without turn events still gets a toast.
        const ended = turnsOf(store.getState(), slug).turns[0];
        if (!ended || toastedEnd !== ended.sessionId) toast(result?.summary ?? 'Turn complete.');
      })
      .catch((error: unknown) => toast(`Turn failed: ${String(error)}`, 'error'))
      .finally(() => {
        starting = false;
        drawTurnButton();
        if (store.getState().project !== slug) return;
        void loadRoster(slug);
        loadArtifacts(slug);
        loadTurns(slug);
      });
  };
  turnButton.addEventListener('click', runTurn);

  function drawTurnButton(): void {
    const project = selected();
    const running = project ? runningTurn(turnsOf(store.getState(), project.slug).turns) : null;
    if (running) {
      turnButton.disabled = true;
      turnButton.classList.add('project__run--running');
      turnButton.replaceChildren(el('span', 'project__spinner'), el('span', 'num', `Running · ${formatClock(Date.now() - running.startedAt)}`));
      turnButton.title = 'A turn is running';
      return;
    }
    turnButton.classList.remove('project__run--running');
    turnButton.disabled = !project || starting || project.status === 'paused';
    turnButton.textContent = starting ? 'Starting…' : 'Run turn';
    turnButton.title = project?.status === 'paused' ? 'Paused — resume it from ⋯ to run a turn' : 'Run one turn now';
  }

  // --- the ⋯ menu ----------------------------------------------------------------------------

  menuButton(moreButton, (): MenuEntry[] => {
    const project = selected();
    if (!project) return [];
    const paused = project.status === 'paused';
    const entries: MenuEntry[] = [
      { label: 'Settings…', icon: 'gear', onSelect: () => openSettings() },
      { label: 'Add employee…', icon: 'personAdd', onSelect: () => openSettings('team') },
      'separator',
      {
        label: paused ? 'Resume project' : 'Pause project',
        icon: paused ? 'play' : 'pause',
        onSelect: () => {
          void sendJson(`/api/projects/${project.slug}/${paused ? 'resume' : 'pause'}`)
            .then(() => toast(`${project.title} ${paused ? 'resumed' : 'paused'}.`))
            .catch((error: unknown) => toast(`Could not ${paused ? 'resume' : 'pause'}: ${String(error)}`, 'error'));
        },
      },
    ];
    if (project.source) {
      entries.push('separator', { label: 'Open the repository', icon: 'external', href: sourceHref(project.source) });
      if (project.source.prUrl) entries.push({ label: 'Open the pull request', icon: 'branch', href: project.source.prUrl });
    }
    return entries;
  });

  // --- the sections --------------------------------------------------------------------------

  /** The section on screen and how to take it down; null while none is mounted. */
  let mounted: { dispose: () => void } | null = null;
  /** The overview's host while the Overview is the section on screen. */
  let overviewHost: HTMLElement | null = null;
  /** A drafter's open questions waiting for the PRD to open with them. */
  let pendingSeed: string[] | null = null;
  /** The Overview asked for a roadmap: the Roadmap opens generating. */
  let pendingGenerate = false;

  function drawOverview(): void {
    if (!overviewHost) return;
    const state = store.getState();
    const project = selected(state);
    if (!project) return;
    const data: OverviewData = {
      project, state, roster, rosterState, prd, roadmap, docs, code, preview, briefing, cost: costText(project.slug),
    };
    renderOverview(overviewHost, data, {
      openCard,
      openTab: (tab, part) => setTab(tab, part),
      invite: (kind) => {
        if (kind === 'turn') { runTurn(); return; }
        if (kind === 'roadmap') { pendingGenerate = true; setTab('plan', 'roadmap', true); return; }
        draftPrd();
      },
      addEmployee: () => openSettings('team'),
    });
  }

  const draftPrd = (): void => {
    const project = selected();
    if (!project) return;
    openProjectWizard(document.body, {
      existing: { slug: project.slug, title: project.title },
      onDone: (_slug, questions) => {
        toast(questions.length
          ? `PRD drafted — ${questions.length} open question${questions.length === 1 ? '' : 's'}`
          : 'PRD drafted.');
        if (store.getState().project !== project.slug) return;
        loadArtifacts(project.slug);
        pendingSeed = questions;
        setTab('plan', 'prd', true);
      },
    });
  };

  /** A slim bar under the toolbar: a sub-segmented control on the left, the view's actions right. */
  const subbar = <T extends string>(
    parts: readonly { id: T; label: string }[] | null, current: T | null, onPick: (id: T) => void, label: string,
  ): { root: HTMLElement; actions: HTMLElement } => {
    const root = el('div', 'subbar');
    const lead = el('div', 'subbar__lead');
    if (parts && current) lead.appendChild(segmented(parts, current, onPick, label).root);
    const actions = el('div', 'subbar__actions');
    root.append(lead, actions);
    return { root, actions };
  };

  function mountSection(): void {
    mounted?.dispose();
    mounted = null;
    overviewHost = null;
    closePane?.();
    body.replaceChildren();
    body.className = 'view__body';
    body.scrollTop = 0;

    const state = store.getState();
    const project = selected(state);
    if (!project) {
      body.appendChild(emptyPage(state));
      return;
    }
    const tab = lastTab;
    view.dataset.tab = tab;
    const ctxFor = (actions?: HTMLElement): ViewContext => ({
      slug: project.slug,
      title: project.title,
      openChat: openPane,
      openArtifact: (id) => { const [t, part] = ARTIFACT_PLACES[id]; setTab(t, part); },
      ...(actions ? { actions } : {}),
    });

    if (tab === 'overview') {
      const host = el('div', 'view__content view__content--narrow');
      overviewHost = host;
      body.appendChild(host);
      drawOverview();
      mounted = { dispose: () => { if (overviewHost === host) overviewHost = null; } };
      return;
    }

    if (tab === 'plan') {
      const part = lastPlan;
      const sub = subbar(PLAN_PARTS, part, (id) => setTab('plan', id), 'Plan');
      const content = el('div', `plan plan--${part}`);
      body.append(sub.root, content);
      const ctx = ctxFor(sub.actions);
      if (part === 'prd') {
        const seed = pendingSeed ?? [];
        pendingSeed = null;
        mounted = { dispose: mountPrd(content, ctx, seed) };
      } else {
        const generate = pendingGenerate;
        pendingGenerate = false;
        mounted = { dispose: mountRoadmap(content, ctx, { generate }) };
      }
      return;
    }

    if (tab === 'docs') {
      const sub = subbar<string>(null, null, () => {}, 'Docs');
      const content = el('div', 'docs-tab');
      body.append(sub.root, content);
      mounted = { dispose: mountDocs(content, ctxFor(sub.actions)) };
      return;
    }

    body.classList.add('view__body--fill');
    if (tab === 'code') {
      const part = lastCode;
      const sub = subbar(CODE_PARTS, part, (id) => setTab('code', id), 'Code');
      const content = el('div', `fill fill--${part}`);
      body.append(sub.root, content);
      const ctx = ctxFor(sub.actions);
      mounted = {
        dispose: part === 'files' ? mountCode(content, ctx)
          : part === 'terminal' ? mountTerminal(content, ctx)
            : mountPreview(content, ctx),
      };
      return;
    }

    const content = el('div', 'fill fill--activity');
    body.appendChild(content);
    mounted = { dispose: mountActivity(content, ctxFor(), { store, roster: () => roster }) };
  }

  /** Moves to `tab` (and `part` of it); `force` remounts even when it is already showing. */
  function setTab(tab: ProjectTab, part?: PlanPart | CodePart, force = false): void {
    const where = (): string => `${lastTab}:${lastTab === 'plan' ? lastPlan : lastTab === 'code' ? lastCode : ''}`;
    const before = where();
    const leaving = lastTab;
    lastTab = tab;
    if (tab === 'plan' && (part === 'prd' || part === 'roadmap')) lastPlan = part;
    if (tab === 'code' && (part === 'files' || part === 'terminal' || part === 'preview')) lastCode = part;
    tabs.set(tab);
    if (before === where() && !force && mounted) return;
    // Leaving a section may have changed what the Overview summarises (an edited PRD, a new page).
    if (tab === 'overview' && leaving !== 'overview') {
      const project = selected();
      if (project) loadArtifacts(project.slug);
    }
    mountSection();
  }

  /** What the page says with no project to show: waiting, or the way to start the first one. */
  const emptyPage = (state: UiState): HTMLElement => {
    const box = el('div', 'empty-page');
    if (!state.hub) {
      box.appendChild(el('p', 'empty-page__line', 'Waiting for the hub…'));
      return box;
    }
    if (state.project) {
      box.appendChild(el('p', 'empty-page__line', `Opening ${state.project}…`));
      return box;
    }
    box.append(
      el('h2', 'empty-page__title', 'No projects yet'),
      el('p', 'empty-page__line', 'Describe something you want built, paste a PRD, or bring a repository from GitHub.'),
    );
    const start = button('New project', 'btn btn--primary');
    start.addEventListener('click', () => openNewProject(store));
    box.appendChild(start);
    return box;
  };

  // --- the toolbar ---------------------------------------------------------------------------

  function drawToolbar(state: UiState): void {
    const project = selected(state);
    titleNode.textContent = project?.title ?? (state.hub ? 'Projects' : '');
    if (project) {
      const kind = projectDot(project, state);
      titleDot.hidden = false;
      titleDot.className = `dot dot--${kind === 'working' ? 'working dot--pulse' : kind}`;
      titleDot.title = DOT_WORDS[kind];
      titleDot.setAttribute('role', 'img');
      titleDot.setAttribute('aria-label', DOT_WORDS[kind]);
    } else {
      titleDot.hidden = true;
    }
    tabs.root.hidden = !project;
    chatButton.hidden = !project;
    turnButton.hidden = !project;
    moreButton.hidden = !project;
    drawTurnButton();
    syncChatButton();
  }

  // --- following a turn ----------------------------------------------------------------------

  /** How many events of the running turn the page has seen; null while none runs. */
  let followedEvents: number | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The parts of the page that move while a turn runs, changed in place: the clock on the Run turn
   * button, the progress line (which lights for a moment on each event), and the Overview's live
   * lines, redrawn per event rather than per tick.
   */
  function followTurn(state: UiState): void {
    const slug = state.project;
    if (!slug) return;
    const running = runningTurn(turnsOf(state, slug).turns);
    progress.hidden = !running;
    if (running) drawTurnButton();

    const seen = running ? running.events.length : null;
    if (seen === followedEvents) return;
    followedEvents = seen;
    if (!running) return;
    drawOverview();
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
    void loadRoster(slug);
    loadArtifacts(slug);
    loadCost(slug);
  }

  // --- the store -----------------------------------------------------------------------------

  let last = '';
  /** The project the page is showing; undefined before the first render. */
  let showingSlug: string | null | undefined;
  let showingFound = false;
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
    const projectChanged = state.project !== showingSlug || !!project !== showingFound;
    if (projectChanged) {
      // A drawer, the pane and the settings sheet all belong to the project we were looking at.
      closeDrawer?.();
      closeDrawer = null;
      settings?.close();
      settings = null;
      showingSlug = state.project;
      showingFound = !!project;
      roster = null;
      rosterState = 'loading';
      followedEvents = null;
      toastedEnd = null;
      prd = loading(); roadmap = loading(); docs = loading(); preview = loading(); code = loading(); briefing = loading();
    }
    if (projectChanged || project?.updatedAt !== rosterUpdatedAt) {
      rosterUpdatedAt = project?.updatedAt;
      if (state.project && project) {
        void loadRoster(state.project);
        loadArtifacts(state.project);
        if (projectChanged) loadTurns(state.project);
      }
    }
    drawToolbar(state);
    if (projectChanged) mountSection();
    else drawOverview();
    settings?.refresh();
    followTurn(state);
  };

  /**
   * A PRD the New project sheet has just drafted opens straight away, carrying the drafter's open
   * questions; taking the seed re-enters this listener with nothing left to take.
   */
  const takeSeed = (state: UiState): void => {
    const seed = state.prdSeed;
    if (!seed || seed.slug !== state.project || !selected(state)) return;
    store.dispatch({ type: 'prd-seed-taken' });
    pendingSeed = seed.questions;
    setTab('plan', 'prd', true);
  };

  /** The sidebar's test for "these keys belong to whatever is focused", applied to `c`. */
  const typing = (): boolean => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && (active.isContentEditable || !!active.closest('.cm-editor, .term')));
  };

  /** `c` opens the manager chat, the same as the toolbar button — the sidebar's `[` sets the pattern. */
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || typing()) return;
    // A drawer already on screen owns the conversation in it, and `c` must not replace someone
    // else's and abort its stream. The manager's own drawer is the exception: there `c` only
    // reaches for its message box.
    if (drawerFor !== 'manager' && document.querySelector('body > .drawer')) return;
    // A sheet owns the screen outright, and a chat in the pane owns its own keys.
    if (focusInDrawer() || document.querySelector('.modal') || pane.contains(document.activeElement)) return;
    event.preventDefault();
    openManagerChat(false);
  };
  window.addEventListener('keydown', onKey);

  const unsubscribe = store.subscribe(render);
  const unseed = store.subscribe(takeSeed);
  render(store.getState());
  takeSeed(store.getState());
  /** The Run turn clock and the Overview's elapsed times, once a second while a turn runs. */
  const clock = setInterval(() => {
    const state = store.getState();
    if (!runningTurn(turnsOf(state, state.project).turns)) return;
    drawTurnButton();
    if (overviewHost) tickOverview(overviewHost);
  }, 1000);

  return () => {
    unsubscribe();
    unseed();
    window.removeEventListener('keydown', onKey);
    clearInterval(clock);
    clearTimeout(progressTimer);
    closeDrawer?.();
    closePane?.();
    settings?.close();
    mounted?.dispose();
    rosterToken++;
    artifactToken++;
    view.remove();
  };
}
