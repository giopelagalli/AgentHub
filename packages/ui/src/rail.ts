import type { HubState, ProjectManifest } from '@agenthub/shared';
import { getJson } from './api.js';
import { badgeLabel } from './badge.js';
import { button, el } from './dom.js';
import { openProjectWizard } from './panels/wizard.js';
import type { Store, UiState } from './store.js';
import { toast } from './toast.js';

/**
 * The left rail: the three whole-app pages, the New project button, and the project list, in one
 * column. `projects` is not a rail link — the list is the projects view, and picking a row is what
 * puts a project back in the main area.
 *
 * Everything above `mountRail` is pure, so the rail's shape can be read without a DOM.
 */

export type PageId = 'projects' | 'computer' | 'cluster' | 'allocation' | 'help';

/** The pages the rail links to; the projects view is reached through the list instead. */
export type RailPageId = Exclude<PageId, 'projects'>;

export interface RailPage {
  id: RailPageId;
  label: string;
  /** One line under the label, so the rail says what each page is for. */
  hint: string;
  /** What stands in for the label once the rail is collapsed to a strip. */
  initial: string;
}

export const RAIL_PAGES: readonly RailPage[] = [
  { id: 'computer', label: 'Computer', hint: 'Shared browser', initial: 'Co' },
  { id: 'cluster', label: 'Cluster', hint: 'Nodes and jobs', initial: 'Cl' },
  { id: 'allocation', label: 'Allocation', hint: 'What runs first', initial: 'Al' },
  { id: 'help', label: 'Help', hint: 'How AgentHub works', initial: 'He' },
];

export interface RailEntry extends RailPage {
  current: boolean;
}

export interface RailModel {
  collapsed: boolean;
  /** Every page link, with the one being shown marked; none is, on a project. */
  entries: RailEntry[];
  /** The New project button's face: the words, or a bare + in the strip. */
  newProjectLabel: string;
  /** The search box and the list are what the strip gives up for its width. */
  showsProjects: boolean;
  /** What the chevron would do next, for its title and its label. */
  toggleLabel: string;
}

/** The rail's shape at this page and this width. */
export function railModel(page: PageId, collapsed: boolean): RailModel {
  return {
    collapsed,
    entries: RAIL_PAGES.map((item) => ({ ...item, current: item.id === page })),
    newProjectLabel: collapsed ? '+' : 'New project',
    showsProjects: !collapsed,
    toggleLabel: collapsed ? 'Expand the rail' : 'Collapse the rail',
  };
}

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

/** How wide the rail was left last time. Storage can be blocked, in which case it opens wide. */
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
    /* private browsing: the rail just forgets between visits */
  }
}

/** Everything the rail draws, short of the roster itself. */
function railSignature(state: UiState): string {
  const projects = state.hub?.projects ?? [];
  return [
    state.page,
    state.project,
    state.hub ? 'hub' : 'waiting',
    projects.map((p) => `${p.slug}:${p.title}:${p.status}:${p.priority}`).join('|'),
  ].join('~');
}

export interface RailOptions {
  /** Told the new width so the shell can give the main area the room. */
  onCollapsed(collapsed: boolean): void;
}

/**
 * Mounts the rail in `host`. It owns its own collapsed state — the chevron and `[` both go
 * through `setCollapsed`, which persists it and hands the shell the new width.
 */
export function mountRail(host: HTMLElement, store: Store, options: RailOptions): void {
  let collapsed = readCollapsed();

  const head = el('div', 'rail__head');
  const brand = el('div', 'rail__brand', 'AgentHub');
  const toggle = button('', 'rail__toggle');
  toggle.appendChild(el('span', 'rail__chevron'));
  head.append(brand, toggle);

  const pages = el('nav', 'rail__pages');
  pages.setAttribute('aria-label', 'Pages');
  const pageButtons = new Map<RailPageId, HTMLButtonElement>();
  for (const item of RAIL_PAGES) {
    const node = button('', 'rail__page');
    node.append(
      el('span', 'rail__initial', item.initial),
      el('span', 'rail__label', item.label),
      el('span', 'rail__hint', item.hint),
    );
    node.addEventListener('click', () => store.dispatch({ type: 'set-page', page: item.id }));
    pages.appendChild(node);
    pageButtons.set(item.id, node);
  }

  const create = el('button', 'btn btn--primary rail__new', 'New project');
  create.type = 'button';
  const search = el('input', 'input rail__search');
  search.type = 'search';
  search.placeholder = 'Search projects';
  const rows = el('div', 'rail__rows');
  const list = el('div', 'rail__list');
  list.append(search, rows);

  const foot = el('div', 'rail__foot');
  const badge = el('span', 'badge');
  foot.appendChild(badge);

  host.append(head, pages, create, list, foot);

  /**
   * A project the hub has only just been told about isn't in the pushed state yet, so pull it
   * before selecting — otherwise the next push would find the slug unknown and move the selection
   * back to the top of the list.
   */
  const drafted = (slug: string, questions: string[]): void => {
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
  };

  create.addEventListener('click', () => {
    openProjectWizard(document.body, { onDone: drafted });
  });

  function renderRows(state: UiState): void {
    const matches = filterProjects(state.hub?.projects ?? [], search.value);
    rows.replaceChildren();
    if (!matches.length) {
      rows.appendChild(el('p', 'empty', state.hub ? 'No projects match.' : 'Waiting for the hub…'));
      return;
    }
    for (const project of matches) {
      const row = button('', 'row');
      if (project.slug === state.project) row.setAttribute('aria-current', 'true');
      row.append(
        el('span', 'row__title', project.title),
        el('span', `pill pill--${project.status}`, project.status),
        el('span', 'row__priority', project.priority),
      );
      row.addEventListener('click', () => {
        store.dispatch({ type: 'set-project', slug: project.slug });
        store.dispatch({ type: 'set-page', page: 'projects' });
      });
      rows.appendChild(row);
    }
  }

  function renderShape(state: UiState): void {
    const model = railModel(state.page, collapsed);
    for (const entry of model.entries) {
      const node = pageButtons.get(entry.id);
      if (!node) continue;
      if (entry.current) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
      node.title = collapsed ? `${entry.label} — ${entry.hint}` : '';
    }
    create.textContent = model.newProjectLabel;
    create.title = 'New project';
    list.hidden = !model.showsProjects;
    toggle.title = model.toggleLabel;
    toggle.setAttribute('aria-label', model.toggleLabel);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    badge.textContent = collapsed ? '' : badgeLabel(state.connection);
    badge.dataset.status = state.connection;
  }

  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    writeCollapsed(next);
    options.onCollapsed(next);
    renderShape(store.getState());
  };

  toggle.addEventListener('click', () => setCollapsed(!collapsed));

  let last = '';
  let connection: UiState['connection'] | null = null;
  const render = (state: UiState): void => {
    if (state.connection !== connection) {
      connection = state.connection;
      renderShape(state);
    }
    const next = railSignature(state);
    if (next === last) return;
    last = next;
    renderShape(state);
    renderRows(state);
  };

  search.addEventListener('input', () => renderRows(store.getState()));

  const typing = (): boolean => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement;
  };

  const onKey = (event: KeyboardEvent): void => {
    if (typing() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '[') {
      event.preventDefault();
      setCollapsed(!collapsed);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Inside a drawer, the wizard or an artifact sheet the same two keys belong to whatever is
    // focused there.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.drawer, .modal, .sheet')) return;
    const state = store.getState();
    const matches = filterProjects(state.hub?.projects ?? [], search.value);
    const next = stepSelection(matches, state.project, event.key === 'ArrowRight' ? 1 : -1);
    if (next && next !== state.project) {
      store.dispatch({ type: 'set-project', slug: next });
      store.dispatch({ type: 'set-page', page: 'projects' });
    }
  };
  window.addEventListener('keydown', onKey);

  options.onCollapsed(collapsed);
  store.subscribe(render);
  render(store.getState());
}
