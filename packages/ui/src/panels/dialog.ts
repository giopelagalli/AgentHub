const CHARS_PER_TICK = 2;

export interface DialogChoice {
  id: string;
  label: string;
}

/** Characters revealed after `ticksSinceOpen` loop ticks (8 ticks/second). */
export function revealCount(ticksSinceOpen: number): number {
  return Math.max(0, ticksSinceOpen) * CHARS_PER_TICK;
}

/** The visible prefix of a dialog's text; the whole thing once the ticks cover it. */
export function revealedText(text: string, ticksSinceOpen: number): string {
  return text.slice(0, revealCount(ticksSinceOpen));
}

interface ActiveDialog {
  advance(tick: number): void;
  dismiss(): void;
}

/** The tower shows one text box at a time, like the games it borrows from. */
let active: ActiveDialog | null = null;

export function dialogIsOpen(): boolean {
  return active !== null;
}

/** Drives the letter-by-letter reveal; called from the 8Hz loop tick. */
export function tickDialog(tick: number): void {
  active?.advance(tick);
}

/** Closes the open box without a choice; its promise resolves to null. */
export function closeDialog(): void {
  active?.dismiss();
}

/**
 * A Game Boy text box along the bottom of the canvas host: the text types
 * itself out at two characters per tick, a click finishes it instantly, and
 * the choices appear as a pointer menu once the text is done. Resolves with
 * the chosen id, or null if the box was dismissed.
 */
export function openDialog(
  host: HTMLElement,
  lines: string[],
  choices: DialogChoice[],
): Promise<string | null> {
  active?.dismiss();

  const text = lines.join('\n');

  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--dialog';

  const body = document.createElement('p');
  body.className = 'gb-dialog__text';
  panel.appendChild(body);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Click to skip';
  panel.appendChild(hint);

  host.appendChild(panel);

  return new Promise<string | null>((resolve) => {
    let startTick: number | null = null;
    let complete = false;

    const settle = (choice: string | null): void => {
      if (active === self) active = null;
      panel.remove();
      resolve(choice);
    };

    const finishReveal = (): void => {
      if (complete) return;
      complete = true;
      body.textContent = text;
      hint.remove();

      const list = document.createElement('ul');
      list.className = 'gb-menu';
      for (const choice of choices) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.label;
        button.addEventListener('click', () => settle(choice.id));
        item.appendChild(button);
        list.appendChild(item);
      }
      panel.appendChild(list);
      list.querySelector('button')?.focus();
    };

    panel.addEventListener('click', () => finishReveal());

    const self: ActiveDialog = {
      advance(tick) {
        if (complete) return;
        startTick ??= tick;
        const shown = revealedText(text, tick - startTick);
        body.textContent = shown;
        if (shown.length === text.length) finishReveal();
      },
      dismiss: () => settle(null),
    };
    active = self;
  });
}
