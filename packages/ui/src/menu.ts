import { button, el } from './dom.js';
import { icon, type IconName } from './icons.js';

/**
 * A pop-up menu under a button — what `⋯` opens. One at a time; it closes on a choice, on Escape,
 * on a click anywhere else, and on scroll. Up and down move between items, as a menu's should.
 */

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** A short note held right, e.g. a keyboard shortcut. */
  hint?: string;
  danger?: boolean;
  /** A link out of the app, opened in a new tab, instead of an action. */
  href?: string;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | 'separator';

let closeOpen: (() => void) | null = null;

export function openMenu(anchor: HTMLElement, entries: MenuEntry[]): () => void {
  closeOpen?.();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const items: HTMLElement[] = [];
  // Where some items carry an icon, the rest keep its column, so the labels line up.
  const iconColumn = entries.some((entry) => entry !== 'separator' && entry.icon);

  for (const entry of entries) {
    if (entry === 'separator') {
      menu.appendChild(el('div', 'menu__sep'));
      continue;
    }
    let node: HTMLElement;
    if (entry.href) {
      const link = el('a', `menu__item${entry.danger ? ' menu__item--danger' : ''}`);
      link.href = entry.href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      node = link;
    } else {
      node = button('', `menu__item${entry.danger ? ' menu__item--danger' : ''}`);
    }
    node.setAttribute('role', 'menuitem');
    node.tabIndex = -1;
    if (entry.icon) node.appendChild(icon(entry.icon, 16));
    else if (iconColumn) node.appendChild(el('span', 'menu__iconspace'));
    node.appendChild(el('span', undefined, entry.label));
    if (entry.hint) node.appendChild(el('span', 'menu__hint', entry.hint));
    node.addEventListener('click', () => {
      close();
      entry.onSelect?.();
    });
    menu.appendChild(node);
    items.push(node);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  // Under the button, opening toward the middle of the window: from its left edge on the left
  // half, from its right edge on the right half.
  const wanted = rect.left + rect.width / 2 < window.innerWidth / 2 ? rect.left : rect.right - width;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, wanted));
  menu.style.left = `${left}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      anchor.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const onPointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) return;
    close();
  };
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  };

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    anchor.setAttribute('aria-expanded', 'false');
    menu.remove();
    if (closeOpen === close) closeOpen = null;
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);
  closeOpen = close;
  items[0]?.focus();
  return close;
}

/**
 * Wires `anchor` to open the menu `entries()` builds — fresh each time, so it reflects the state
 * at the moment it opens — and to close it again on a second press.
 */
export function menuButton(anchor: HTMLButtonElement, entries: () => MenuEntry[]): void {
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  let close: (() => void) | null = null;
  anchor.addEventListener('click', () => {
    if (anchor.getAttribute('aria-expanded') === 'true' && close) {
      close();
      close = null;
      return;
    }
    close = openMenu(anchor, entries());
  });
}
