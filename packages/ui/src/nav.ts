import type { Store, UiState } from './store.js';

/** The four pages of the app; the left nav is one button per entry, in this order. */
export type PageId = 'projects' | 'computer' | 'cluster' | 'allocation';

export interface NavItem {
  id: PageId;
  label: string;
  /** One line under the label, so the nav says what each page is for. */
  hint: string;
}

export const PAGES: NavItem[] = [
  { id: 'projects', label: 'Projects', hint: 'Teams and chat' },
  { id: 'computer', label: 'Computer', hint: 'Shared browser' },
  { id: 'cluster', label: 'Cluster', hint: 'Nodes and jobs' },
  { id: 'allocation', label: 'Allocation', hint: 'What runs first' },
];

export interface NavEntry extends NavItem {
  current: boolean;
}

/** The nav bar's model: every page, with the one being shown marked. */
export function navModel(page: PageId): NavEntry[] {
  return PAGES.map((item) => ({ ...item, current: item.id === page }));
}

/** Mounts the left nav in `host` and keeps the current-page marker in step with the store. */
export function mountNav(host: HTMLElement, store: Store): void {
  const list = document.createElement('nav');
  list.className = 'nav__pages';
  list.setAttribute('aria-label', 'Pages');
  host.appendChild(list);

  const buttons = new Map<PageId, HTMLButtonElement>();
  for (const item of PAGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav__page';
    const label = document.createElement('span');
    label.className = 'nav__label';
    label.textContent = item.label;
    const hint = document.createElement('span');
    hint.className = 'nav__hint';
    hint.textContent = item.hint;
    button.append(label, hint);
    button.addEventListener('click', () => store.dispatch({ type: 'set-page', page: item.id }));
    list.appendChild(button);
    buttons.set(item.id, button);
  }

  const render = (state: UiState): void => {
    for (const entry of navModel(state.page)) {
      const button = buttons.get(entry.id);
      if (!button) continue;
      if (entry.current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };

  store.subscribe(render);
  render(store.getState());
}
