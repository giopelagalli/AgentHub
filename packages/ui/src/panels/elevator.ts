import { FLOORS, type FloorId } from '../floors.js';

/**
 * The elevator's floor menu: top floor first, like the buttons in the car.
 * Picking a floor only reports it — the caller's FSM decides what happens
 * next and closes the menu.
 */
export function openElevatorMenu(
  host: HTMLElement,
  current: FloorId,
  onChoose: (floor: FloorId) => void,
): () => void {
  const panel = document.createElement('div');
  panel.className = 'gb-panel gb-panel--menu';

  const heading = document.createElement('h2');
  heading.textContent = 'Floor';
  panel.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'gb-menu';
  for (const floor of [...FLOORS].reverse()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = floor.label;
    if (floor.id === current) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => onChoose(floor.id));
    item.appendChild(button);
    list.appendChild(item);
  }
  panel.appendChild(list);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Esc to cancel';
  panel.appendChild(hint);

  host.appendChild(panel);
  list.querySelector('button')?.focus();
  return () => panel.remove();
}
