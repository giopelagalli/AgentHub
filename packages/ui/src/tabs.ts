import type { HubState } from '@agenthub/shared';
import { floorsFor, type FloorId } from './floors.js';
import type { Store, UiState } from './store.js';

export interface Tab {
  id: FloorId;
  label: string;
}

/**
 * The tab bar's model: one tab per live floor, left to right in tower order.
 * A pure projection of `floorsFor`, so project tabs appear and disappear with
 * the projects themselves.
 */
export function tabsFor(state: UiState | { hub: HubState | null }): Tab[] {
  return floorsFor(state).map(({ id, label }) => ({ id, label }));
}

/**
 * Mounts the tab bar in `host` and keeps it in step with the store: the bar is
 * rebuilt whenever the floor list or the current floor changes, and a click
 * switches floor immediately. Returns nothing — the bar lives as long as the page.
 */
export function mountTabs(host: HTMLElement, store: Store): void {
  const bar = document.createElement('nav');
  bar.className = 'gb-tabs';
  bar.setAttribute('aria-label', 'Floors');
  host.appendChild(bar);

  let signature = '';

  const render = (state: UiState): void => {
    const tabs = tabsFor(state);
    const next = `${state.floor}|${tabs.map((t) => `${t.id}:${t.label}`).join(',')}`;
    if (next === signature) return;
    signature = next;

    bar.replaceChildren();
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gb-tabs__tab';
      button.textContent = tab.label;
      if (tab.id === state.floor) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => store.dispatch({ type: 'set-floor', floor: tab.id }));
      bar.appendChild(button);
    }
  };

  store.subscribe(render);
  render(store.getState());
}
