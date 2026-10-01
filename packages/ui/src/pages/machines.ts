import { el } from '../dom.js';
import type { PageId } from '../rail.js';
import type { Store } from '../store.js';
import { segmented, toolbar, type Segment } from '../toolbar.js';
import { mountAllocation } from './allocation.js';
import { mountCluster } from './cluster.js';
import { mountComputer } from './computer.js';

/**
 * Machines: what the hub runs on and how it reaches out, in one place with a segmented control —
 * the nodes, the shared browser, the queue. Each section is the page it used to be, mounted under
 * this toolbar, and keeps its old page id in the store (see `PageId`).
 */

type Section = Extract<PageId, 'cluster' | 'computer' | 'allocation'>;

const SECTIONS: readonly Segment<Section>[] = [
  { id: 'cluster', label: 'Nodes' },
  { id: 'computer', label: 'Browser' },
  { id: 'allocation', label: 'Queue' },
];

const MOUNTS: Record<Section, (host: HTMLElement, store: Store) => () => void> = {
  cluster: mountCluster,
  computer: mountComputer,
  allocation: mountAllocation,
};

const sectionOf = (page: PageId): Section =>
  SECTIONS.some((s) => s.id === page) ? (page as Section) : 'cluster';

export function mountMachines(host: HTMLElement, store: Store): () => void {
  const view = el('div', 'view');
  const bar = toolbar();
  bar.leading.appendChild(el('h1', 'toolbar__title', 'Machines'));
  const body = el('div', 'view__body');
  const inner = el('div', 'view__content');
  body.appendChild(inner);
  view.append(bar.root, body);
  host.appendChild(view);

  let showing: Section | null = null;
  let teardown: (() => void) | null = null;

  const control = segmented(SECTIONS, sectionOf(store.getState().page), (id) => {
    store.dispatch({ type: 'set-page', page: id });
  }, 'Machines sections');
  bar.center.appendChild(control.root);

  const show = (page: PageId): void => {
    const next = sectionOf(page);
    if (next === showing) return;
    showing = next;
    control.set(next);
    teardown?.();
    inner.replaceChildren();
    teardown = MOUNTS[next](inner, store);
  };

  const unsubscribe = store.subscribe((state) => show(state.page));
  show(store.getState().page);

  return () => {
    unsubscribe();
    teardown?.();
    view.remove();
  };
}
