import { button, el } from './dom.js';
import { icon, type IconName } from './icons.js';

/**
 * The window's toolbar, one per page: what you are looking at on the left, the page's sections in
 * the middle, and what you can do on the right. Every page builds its own through `toolbar()` so
 * the three slots line up the same everywhere.
 *
 * The sidebar button at the far left is the one way back to the sidebar once it is hidden; it
 * talks to the sidebar through a window event rather than a handle, so a page never needs to know
 * where the sidebar lives.
 */

export const SIDEBAR_EVENT = 'agenthub:toggle-sidebar';

/** The sidebar's element id, which every sidebar button `aria-controls`. */
export const SIDEBAR_ID = 'sidebar';

/** Whether the sidebar shows right now; the sidebar keeps it current, every toolbar reads it. */
let sidebarExpanded = true;

/** Told by the sidebar whenever it shows or hides, so each toolbar's button says so. */
export function setSidebarExpanded(expanded: boolean): void {
  sidebarExpanded = expanded;
  for (const node of document.querySelectorAll('.toolbar__sidebar')) node.setAttribute('aria-expanded', String(expanded));
}

export interface Toolbar {
  root: HTMLElement;
  /** After the sidebar button: the title, and anything that belongs to it. */
  leading: HTMLElement;
  /** The page's segmented control, centred. */
  center: HTMLElement;
  /** Actions, held right; the primary goes last. */
  trailing: HTMLElement;
}

export function toolbar(): Toolbar {
  const root = el('header', 'toolbar');
  const leading = el('div', 'toolbar__leading');
  const center = el('div', 'toolbar__center');
  const trailing = el('div', 'toolbar__trailing');

  const sidebar = iconButton('sidebar', 'Show the sidebar ([)', 'toolbar__sidebar');
  sidebar.setAttribute('aria-controls', SIDEBAR_ID);
  sidebar.setAttribute('aria-expanded', String(sidebarExpanded));
  sidebar.addEventListener('click', () => window.dispatchEvent(new CustomEvent(SIDEBAR_EVENT)));
  leading.appendChild(sidebar);

  root.append(leading, center, trailing);
  return { root, leading, center, trailing };
}

/** A borderless square button carrying one icon; `label` is both its tooltip and its name. */
export function iconButton(name: IconName, label: string, className = ''): HTMLButtonElement {
  const node = button('', `btn btn--icon${className ? ` ${className}` : ''}`);
  node.appendChild(icon(name, 18));
  node.title = label;
  node.setAttribute('aria-label', label.replace(/\s*\(.*\)$/, ''));
  return node;
}

export interface Segment<T extends string> {
  id: T;
  label: string;
}

export interface SegmentedControl<T extends string> {
  root: HTMLElement;
  /** Lights `id` without firing `onPick`. */
  set(id: T): void;
}

/**
 * A segmented control: a row of mutually exclusive choices, the current one raised. Arrow keys
 * move between them, as a tablist's do.
 */
export function segmented<T extends string>(
  items: readonly Segment<T>[], current: T, onPick: (id: T) => void, label: string,
): SegmentedControl<T> {
  const root = el('div', 'seg');
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', label);
  const nodes = items.map((item) => {
    const node = button(item.label, 'seg__option');
    node.setAttribute('role', 'tab');
    node.dataset.id = item.id;
    node.addEventListener('click', () => { set(item.id); onPick(item.id); });
    root.appendChild(node);
    return node;
  });
  const set = (id: T): void => {
    for (const node of nodes) {
      const on = node.dataset.id === id;
      node.setAttribute('aria-selected', String(on));
      node.tabIndex = on ? 0 : -1;
    }
  };
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = nodes.findIndex((node) => node === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nodes[(at + (event.key === 'ArrowRight' ? 1 : nodes.length - 1)) % nodes.length];
    next.focus();
    next.click();
  });
  set(current);
  return { root, set };
}
