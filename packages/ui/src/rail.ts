import type { HubState, ProjectManifest } from '@agenthub/shared';
import { getJson } from './api.js';
import { badgeLabel } from './badge.js';
import { button, el } from './dom.js';
import { icon, type IconName } from './icons.js';
import { openProjectWizard } from './panels/wizard.js';
import { turnsOf, type Store, type UiState } from './store.js';
import { toast } from './toast.js';
import { SIDEBAR_EVENT, SIDEBAR_ID, iconButton, setSidebarExpanded } from './toolbar.js';
import { runningTurn } from './turns.js';

/**
 * The sidebar: navigation and nothing else. The projects are the list; New project is the `+` in
 * its header; the two system places — Machines and Help — sit small at the bottom. It hides with
 * the toolbar's sidebar button or `[`, and on a phone-width window it is a drawer over the page.
 *
 * Everything above `mountRail` is pure, so the sidebar's shape can be read without a DOM.
 */

/**
 * Every screen the main area can show. Machines is one place with four sections, and each section
 * keeps the id of the page it used to be (`cluster` is Nodes, `computer` the shared browser,
 * `allocation` the queue), so the socket's browser subscription and the store need no translation.
 */
export type PageId = 'projects' | 'cluster' | 'computer' | 'allocation' | 'access' | 'help';

/** The sidebar's system places; the projects view is reached through the list instead. */
export type RailPlace = 'machines' | 'help';

export interface RailPage {
  id: RailPlace;
  label: string;
  icon: IconName;
  /** Where clicking the entry lands. */
  page: PageId;
}

export const RAIL_PAGES: readonly RailPage[] = [
  { id: 'machines', label: 'Machines', icon: 'machines', page: 'cluster' },
  { id: 'help', label: 'Help', icon: 'help', page: 'help' },
];

/** The four sections of Machines, in the order its segmented control shows them. */
export const MACHINE_PAGES: readonly PageId[] = ['cluster', 'computer', 'allocation', 'access'];

/** Which sidebar place a page belongs to; a project belongs to none. */
export function placeOf(page: PageId): RailPlace | null {
  if (page === 'help') return 'help';
  return MACHINE_PAGES.includes(page) ? 'machines' : null;
}

export interface RailEntry extends RailPage {
  current: boolean;
}

export interface RailModel {
  collapsed: boolean;
  /** Every place, with the one being shown marked; none is, on a project. */
  entries: RailEntry[];
  /** What the sidebar button would do next, for its title and its label. */
  toggleLabel: string;
}

/** The sidebar's shape at this page. */
export function railModel(page: PageId, collapsed: boolean): RailModel {
  const place = placeOf(page);
  return {
    collapsed,
    entries: RAIL_PAGES.map((item) => ({ ...item, current: item.id === place })),
    toggleLabel: collapsed ? 'Show the sidebar' : 'Hide the sidebar',
  };
}

/**
 * A project's dot: green while a turn runs, amber when it is blocked on the owner, red when its
 * last turn failed (from the hub's own record until the browser has the turns), a hollow ring while paused, grey otherwise. A turn is only known about for a
 * project whose turns have reached the store, which is every one the socket has reported on.
 */
export type ProjectDot = 'working' | 'needs' | 'error' | 'paused' | 'idle' | 'done';

export function projectDot(project: ProjectManifest, state: UiState): ProjectDot {
  const turns = turnsOf(state, project.slug).turns;
  if (runningTurn(turns)) return 'working';
  if (project.status === 'paused') return 'paused';
  if (project.status === 'done') return 'done';
  if (project.status === 'blocked') return 'needs';
  // The browser's own turns are fresher than the hub's snapshot, so the snapshot is only the fallback.
  const outcome = turns.length ? turns[0].outcome : project.lastTurn?.outcome;
  if (outcome && /fail|error|abort/i.test(outcome)) return 'error';
  return 'idle';
}

/** The dot's words, for its tooltip and for a screen reader. */
export const DOT_WORDS: Record<ProjectDot, string> = {
  working: 'Working',
  needs: 'Needs you',
  error: 'Last turn failed',
  paused: 'Paused',
  idle: 'Idle',
  done: 'Done',
};

/** Free-text filter over the project list: a case-insensitive match on title or slug. */
export function filterProjects(projects: ProjectManifest[], query: string): ProjectManifest[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter(
    (p) => p.title.toLowerCase().includes(needle) || p.slug.toLowerCase().includes(needle),
  );
}

/** Where ←/→ land from `slug` in `projects`; the ends don't wrap. */
export function stepSelection(projects: ProjectManifest[], slug: string | null, step: 1 | -1): string | null {
  if (!projects.length) return null;
  const at = projects.findIndex((p) => p.slug === slug);
  if (at < 0) return projects[0].slug;
  return projects[Math.min(projects.length - 1, Math.max(0, at + step))].slug;
}

const COLLAPSED_KEY = 'agenthub.rail.collapsed';

/** Whether the sidebar was left hidden last time. Storage can be blocked, in which case it shows. */
export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* private browsing: the sidebar just forgets between visits */
  }
}

/** Everything the sidebar draws. */
function railSignature(state: UiState): string {
  const projects = state.hub?.projects ?? [];
  return [
    state.page,
    state.project,
    state.connection,
    state.hub ? 'hub' : 'waiting',
    projects.map((p) => `${p.slug}:${p.title}:${projectDot(p, state)}`).join('|'),
  ].join('~');
}

export interface RailOptions {
  /** Told how the sidebar now sits, so the shell can lay the window out around it. */
  onLayout(layout: { collapsed: boolean; drawerOpen: boolean }): void;
}

/**
 * The New project sheet, and what happens once it has drafted a PRD: the project is selected, the
 * page lands on it, and the drafter's open questions ride along to the PRD.
 *
 * A project the hub has only just been told about isn't in the pushed state yet, so it is pulled
 * before selecting — otherwise the next push would find the slug unknown and move the selection
 * back to the top of the list.
 */
export function openNewProject(store: Store): void {
  openProjectWizard(document.body, {
    onDone: (slug, questions) => {
      void getJson<HubState>('/api/state')
        .then((state) => store.dispatch({ type: 'hub-state', state }))
        .catch(() => { /* the socket will bring it along in a moment */ })
        .finally(() => {
          store.dispatch({ type: 'set-project', slug });
          store.dispatch({ type: 'set-page', page: 'projects' });
          store.dispatch({ type: 'prd-drafted', slug, questions });
          toast(questions.length
            ? `PRD drafted — ${questions.length} open question${questions.length === 1 ? '' : 's'}`
            : 'PRD drafted.');
        });
    },
  });
}

/** Narrower than this, the sidebar stops sharing the window and becomes a drawer over it. */
const NARROW = '(max-width: 760px)';

/**
 * Mounts the sidebar in `host`. It owns whether it shows: the toolbar's button and `[` both go
 * through `toggle`, which on a wide window hides or shows it (and remembers that), and on a narrow
 * one opens or closes the drawer.
 */
export function mountRail(host: HTMLElement, store: Store, options: RailOptions): void {
  let collapsed = readCollapsed();
  let drawerOpen = false;
  const narrow = typeof matchMedia === 'function' ? matchMedia(NARROW) : null;

  host.setAttribute('aria-label', 'Sidebar');
  host.id = SIDEBAR_ID;

  const head = el('div', 'sidebar__head');
  const brand = el('div', 'sidebar__brand', 'AgentHub');
  const create = iconButton('plus', 'New project');
  const hide = iconButton('sidebar', 'Hide the sidebar ([)');
  hide.setAttribute('aria-controls', SIDEBAR_ID);
  head.append(brand, create, hide);

  const searchBox = el('label', 'sidebar__search');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search';
  search.setAttribute('aria-label', 'Search projects');
  searchBox.append(icon('search', 14), search);

  const list = el('nav', 'sidebar__list');
  list.setAttribute('aria-label', 'Projects');
  const listHead = el('div', 'sidebar__section', 'Projects');
  const rows = el('div', 'sidebar__rows');
  list.append(listHead, rows);

  const foot = el('nav', 'sidebar__foot');
  foot.setAttribute('aria-label', 'System');
  const placeButtons = new Map<RailPlace, HTMLButtonElement>();
  for (const item of RAIL_PAGES) {
    const node = button('', 'sidebar__row sidebar__place');
    node.append(icon(item.icon, 16), el('span', 'sidebar__title', item.label));
    node.addEventListener('click', () => {
      store.dispatch({ type: 'set-page', page: item.page });
      closeDrawer();
    });
    foot.appendChild(node);
    placeButtons.set(item.id, node);
  }
  const status = el('div', 'sidebar__status');
  const statusDot = el('span', 'dot');
  const statusText = el('span');
  status.append(statusDot, statusText);
  status.setAttribute('role', 'status');
  foot.appendChild(status);

  host.append(head, searchBox, list, foot);

  create.addEventListener('click', () => {
    closeDrawer();
    openNewProject(store);
  });

  function renderRows(state: UiState): void {
    const matches = filterProjects(state.hub?.projects ?? [], search.value);
    rows.replaceChildren();
    if (!matches.length) {
      rows.appendChild(el('p', 'sidebar__empty', state.hub
        ? (search.value.trim() ? 'No projects match.' : 'No projects yet.')
        : 'Waiting for the hub…'));
      return;
    }
    for (const project of matches) {
      const row = button('', 'sidebar__row');
      const onProject = state.page === 'projects' && project.slug === state.project;
      if (onProject) row.setAttribute('aria-current', 'page');
      const kind = projectDot(project, state);
      const dot = el('span', `dot dot--${kind === 'working' ? 'working dot--pulse' : kind}`);
      dot.title = DOT_WORDS[kind];
      row.append(dot, el('span', 'sidebar__title', project.title), el('span', 'sr-only', `, ${DOT_WORDS[kind]}`));
      row.title = project.title;
      row.addEventListener('click', () => {
        store.dispatch({ type: 'set-project', slug: project.slug });
        store.dispatch({ type: 'set-page', page: 'projects' });
        closeDrawer();
      });
      rows.appendChild(row);
    }
  }

  function renderShape(state: UiState): void {
    const model = railModel(state.page, collapsed);
    for (const entry of model.entries) {
      const node = placeButtons.get(entry.id);
      if (!node) continue;
      if (entry.current) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    const word = badgeLabel(state.connection);
    statusText.textContent = word.charAt(0) + word.slice(1).toLowerCase();
    statusDot.className = `dot dot--${state.connection === 'live' ? 'working' : state.connection === 'polling' ? 'needs' : 'error'}`;
    status.title = state.connection === 'live'
      ? 'Connected to the hub'
      : state.connection === 'polling' ? 'The live connection dropped; reading the hub every few seconds' : 'The hub is not answering';
  }

  const layout = (): void => {
    const isNarrow = narrow?.matches ?? false;
    const shown = isNarrow ? drawerOpen : !collapsed;
    // Keyboard focus never stays inside a sidebar that is going away: it moves to the page's own
    // sidebar button, which is what brings it back.
    const hadFocus = !shown && host.contains(document.activeElement);
    host.inert = !shown;
    options.onLayout({ collapsed, drawerOpen: isNarrow && drawerOpen });
    hide.setAttribute('aria-expanded', String(shown));
    setSidebarExpanded(shown);
    if (hadFocus) document.querySelector<HTMLElement>('.page .toolbar__sidebar')?.focus();
  };

  function closeDrawer(): void {
    if (!drawerOpen) return;
    drawerOpen = false;
    layout();
  }

  const toggle = (): void => {
    if (narrow?.matches) {
      drawerOpen = !drawerOpen;
      layout();
      if (drawerOpen) host.querySelector<HTMLElement>('[aria-current="page"], .sidebar__row')?.focus({ preventScroll: true });
      return;
    }
    collapsed = !collapsed;
    writeCollapsed(collapsed);
    layout();
  };

  hide.addEventListener('click', toggle);
  window.addEventListener(SIDEBAR_EVENT, toggle);
  narrow?.addEventListener('change', () => { drawerOpen = false; layout(); });
  // A tap on the dimmed page beside the open drawer closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!drawerOpen || !(event.target instanceof Node) || host.contains(event.target)) return;
    if ((event.target as HTMLElement).closest?.('.toolbar__sidebar')) return;
    closeDrawer();
  });

  let last = '';
  const render = (state: UiState): void => {
    const next = railSignature(state);
    if (next === last) return;
    last = next;
    renderShape(state);
    renderRows(state);
  };

  search.addEventListener('input', () => renderRows(store.getState()));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value) { search.value = ''; renderRows(store.getState()); }
  });

  const typing = (): boolean => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && active.isContentEditable);
  };

  const onKey = (event: KeyboardEvent): void => {
    // Escape closes the phone drawer even from its own search box.
    if (event.key === 'Escape' && drawerOpen) { closeDrawer(); return; }
    if (typing() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '[') {
      event.preventDefault();
      toggle();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Inside a drawer, the wizard, a sheet, an editor or a terminal the same two keys belong to
    // whatever is focused there.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.drawer, .modal, .sheet, .cm-editor, .term, .seg, .menu')) return;
    const state = store.getState();
    const matches = filterProjects(state.hub?.projects ?? [], search.value);
    const next = stepSelection(matches, state.project, event.key === 'ArrowRight' ? 1 : -1);
    if (next && next !== state.project) {
      store.dispatch({ type: 'set-project', slug: next });
      store.dispatch({ type: 'set-page', page: 'projects' });
    }
  };
  window.addEventListener('keydown', onKey);

  layout();
  store.subscribe(render);
  render(store.getState());
}
