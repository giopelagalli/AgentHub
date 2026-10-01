import { el } from '../dom.js';

/**
 * A sheet over the window: a dimmed scrim, one box in the middle, focus kept inside it, Escape and
 * a click on the scrim to close. The settings sheet and the New project sheet are both this; what
 * goes in the box is theirs.
 */

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]';

export interface ModalHandle {
  /** The box: the caller fills it. */
  box: HTMLElement;
  close(): void;
}

export interface ModalOptions {
  /** Extra class on the box, which decides its size and layout. */
  className: string;
  /** What a screen reader announces the dialog as. */
  label: string;
  /** Called once, whichever way it was closed. */
  onClose?: () => void;
}

export function openModal(host: HTMLElement, options: ModalOptions): ModalHandle {
  const scrim = el('div', 'modal');
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', options.label);
  const box = el('div', `modal__box ${options.className}`);
  scrim.appendChild(box);

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    returnFocus?.focus();
    options.onClose?.();
  };

  // Capture, so a control that stops the event from bubbling can't let focus walk out into the
  // page behind the scrim — and so a chat drawer's own Escape, on window, never fires under this.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // A menu open inside the box closes first.
      if (box.querySelector('.menu')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
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

  scrim.addEventListener('mousedown', (event) => { if (event.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  host.appendChild(scrim);
  return { box, close };
}
