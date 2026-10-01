import { el } from '../dom.js';
import type { PageId } from '../rail.js';
import type { Store } from '../store.js';
import { segmented, toolbar, type Segment } from '../toolbar.js';
import { mountAllocation } from './allocation.js';
import { mountAccess, mountJobs, mountNodes } from './cluster.js';
import { mountComputer } from './computer.js';

/**
 * Machines: what the hub runs on and how it reaches out, in one place with a segmented control —
 * Nodes (with the cloud spend), the shared Browser, the Queue (the running order and the jobs),
 * and Access (API tokens and GitHub). Each section keeps the page id it had before the merge
 * (see `PageId`), so the store and the socket's browser subscription read it unchanged.
 */

type Section = Extract<PageId, 'cluster' | 'computer' | 'allocation' | 'access'>;

const SECTIONS: readonly Segment<Section>[] = [
  { id: 'cluster', label: 'Nodes' },
  { id: 'computer', label: 'Browser' },
  { id: 'allocation', label: 'Queue' },
  { id: 'access', label: 'Access' },
];

type Mount = (host: HTMLElement, store: Store) => () => void;

/** Several mounts stacked as one section. */
const both = (...mounts: Mount[]): Mount => (host, store) => {
  const stack = el('div', 'msections');
  host.appendChild(stack);
  const downs = mounts.map((mount) => mount(stack, store));
  return () => {
    for (const down of downs) down();
    stack.remove();
  };
};

const MOUNTS: Record<Section, Mount> = {
  cluster: mountNodes,
  computer: mountComputer,
  allocation: both(mountAllocation, mountJobs),
  access: mountAccess,
};

const sectionOf = (page: PageId): Section =>
  SECTIONS.some((s) => s.id === page) ? (page as Section) : 'cluster';

export function mountMachines(host: HTMLElement, store: Store): () => void {
  const view = el('div', 'view machines');
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
    view.dataset.section = next;
    teardown?.();
    inner.replaceChildren();
    body.scrollTop = 0;
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
