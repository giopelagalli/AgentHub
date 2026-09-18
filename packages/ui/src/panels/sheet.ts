import { button, el } from '../dom.js';
import { openChat, type ChatTarget } from './chat.js';

/**
 * The sheet: a near-full-screen overlay one artifact is read and edited in, so the org chart it
 * covers is never traded away for a tab.
 *
 * The "Chat to adjust" drawer belongs to the sheet rather than the page — it mounts into the
 * sheet's own right-hand slot, which the box makes room for, so the document and the conversation
 * about it are usable at the same time.
 */

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select, textarea, [href]';

export interface SheetHandle {
  /** Where the view mounts. */
  body: HTMLElement;
  /** Re-labels the header when the sheet swaps to another artifact. */
  setTitle(title: string, subtitle: string): void;
  /**
   * `document` centres one reading column and scrolls it; `wide` hands the view the whole body,
   * unscrolled, for a layout that manages its own columns.
   */
  setLayout(layout: 'document' | 'wide'): void;
  /** Opens the chat drawer beside the view, closing whichever one is already open. */
  openChat(target: ChatTarget): void;
  close(): void;
}

export interface SheetOptions {
  /** Called once, whichever way the sheet was closed. */
  onClose(): void;
}

export function openSheet(host: HTMLElement, options: SheetOptions): SheetHandle {
  const scrim = el('div', 'sheet');
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  const box = el('div', 'sheet__box');
  scrim.appendChild(box);

  const head = el('header', 'sheet__head');
  const text = el('div');
  const heading = el('h2');
  const subtitle = el('p', 'sheet__sub');
  text.append(heading, subtitle);
  const close = button('×', 'drawer__close');
  close.title = 'Close (Esc)';
  head.append(text, close);
  scrim.setAttribute('aria-label', 'Artifact');

  const scroll = el('div', 'sheet__body');
  // One column inside the scroller, so a near-full-screen overlay doesn't strand the document
  // against its left edge.
  const body = el('div', 'sheet__column');
  scroll.appendChild(body);
  const chatSlot = el('aside', 'sheet__chat');
  chatSlot.hidden = true;
  box.append(head, scroll, chatSlot);

  /** Where focus goes back to when the sheet closes. */
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closeChat: (() => void) | null = null;
  let closed = false;

  const dropChat = (): void => {
    closeChat = null;
    chatSlot.hidden = true;
    chatSlot.replaceChildren();
    box.classList.remove('sheet__box--chat');
  };

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    closeChat?.();
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    returnFocus?.focus();
    options.onClose();
  };

  // Esc closes the chat first if one is open, then the sheet; Tab cycles inside the box and
  // nowhere else. Capture, so a control that stops the event from bubbling can't let focus walk
  // out into the page behind the scrim — and so the chat's own Esc handler, which listens on
  // window, never fires under this one.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (closeChat) closeChat();
      else dispose();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !box.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  close.addEventListener('click', dispose);
  scrim.addEventListener('mousedown', (event) => { if (event.target === scrim) dispose(); });
  document.addEventListener('keydown', onKey, true);
  host.appendChild(scrim);

  return {
    body,
    setTitle: (title, sub) => {
      heading.textContent = title;
      subtitle.textContent = sub;
      scrim.setAttribute('aria-label', `${title} — ${sub}`);
    },
    setLayout: (layout) => {
      box.classList.toggle('sheet__box--wide', layout === 'wide');
    },
    openChat: (target) => {
      closeChat?.();
      chatSlot.hidden = false;
      box.classList.add('sheet__box--chat');
      closeChat = openChat(chatSlot, { ...target, onClose: dropChat });
    },
    close: dispose,
  };
}
