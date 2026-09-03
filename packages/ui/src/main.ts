import './panels/panels.css';
import { PALETTE } from './art/palette.js';
import { badgeLabel } from './badge.js';
import { Elevator } from './elevator.js';
import { bindPointer } from './engine/input.js';
import { startLoop } from './engine/loop.js';
import { Screen } from './engine/screen.js';
import { FLOORS } from './floors.js';
import { connect } from './net.js';
import { openChat } from './panels/chat.js';
import { closeDialog, dialogIsOpen, openDialog, tickDialog } from './panels/dialog.js';
import { openElevatorMenu } from './panels/elevator.js';
import { openNodeInfo } from './panels/nodeinfo.js';
import { openQueuePanel } from './panels/queue.js';
import { hotspotsFor } from './render/floorplans.js';
import { renderFloor } from './render/scene.js';
import { Store } from './store.js';

function hostElement(): HTMLElement {
  const element = document.getElementById('app');
  if (!element) throw new Error('#app host element not found');
  return element;
}

const app = hostElement();

// The panel stylesheet reads the canvas palette through these.
for (const [name, hex] of Object.entries(PALETTE)) {
  document.documentElement.style.setProperty(`--c-${name}`, hex);
}

const screen = new Screen(app);
const store = new Store();

const badge = document.createElement('div');
badge.className = 'gb-badge';
app.appendChild(badge);
store.subscribe((state) => {
  badge.textContent = badgeLabel(state.connection);
});
badge.textContent = badgeLabel(store.getState().connection);

/** Informational panels, newest last: Esc closes the one on top. */
const panels: (() => void)[] = [];

/** Returns a dismiss that closes the panel and drops it from the stack, once. */
function openPanel(close: () => void): () => void {
  const dismiss = (): void => {
    const index = panels.indexOf(dismiss);
    if (index >= 0) panels.splice(index, 1);
    close();
  };
  panels.push(dismiss);
  return dismiss;
}

function closeTopPanel(): void {
  panels[panels.length - 1]?.();
}

let closeMenu: (() => void) | null = null;

const elevator = new Elevator(store, (state) => {
  closeMenu?.();
  closeMenu = null;
  if (state.kind === 'menuOpen') {
    closeMenu = openElevatorMenu(document.body, store.getState().floor, (floor) =>
      elevator.choose(floor),
    );
  }
});

/** One chat at a time: a second one would land on top of the first. */
let dismissChat: (() => void) | null = null;

async function greetAgent(agent: { id: number; name: string }): Promise<void> {
  const name = agent.name.toUpperCase();
  const busy = store.getState().busy.has(agent.id);
  const choice = await openDialog(
    app,
    [busy ? `${name} is hard at work!` : `${name} is taking a breather.`],
    busy
      ? [
          { id: 'watch', label: 'Watch' },
          { id: 'talk', label: 'Talk' },
          { id: 'close', label: 'Close' },
        ]
      : [
          { id: 'talk', label: 'Talk' },
          { id: 'close', label: 'Close' },
        ],
  );
  if (choice !== 'talk') return;
  dismissChat?.();
  dismissChat = openPanel(openChat(document.body, agent));
}

// Signboards: a dialog with nothing to choose but Close.
const SIGNS: Record<string, [string, string]> = {
  'sample:board': ['SAMPLE PROJECT FLOOR', 'Project floors arrive in Phase 3.'],
  'sample:orch': ['SAMPLE ORCHESTRATOR', 'A real one moves in with Phase 3.'],
  reception: ['RECEPTION', 'Assistant — arriving Phase 4.'],
  briefing: ['BRIEFING BOARD', 'First briefing: Phase 3.'],
};

bindPointer(screen.canvas, (x, y) => {
  if (elevator.state.kind !== 'idle' || dialogIsOpen()) return;
  const state = store.getState();
  const spot = hotspotsFor(state.floor, state).find(
    (h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h,
  );
  if (!spot) return;

  // The lobby directory board is a second call button for the same car.
  if (spot.id === 'elevator' || spot.id === 'directory') {
    elevator.open();
    return;
  }
  if (spot.id === 'jobboard') {
    openPanel(openQueuePanel(document.body, state));
    return;
  }
  if (spot.id in SIGNS) {
    void openDialog(app, SIGNS[spot.id], [{ id: 'close', label: 'Close' }]);
    return;
  }
  if (spot.id.startsWith('rack:')) {
    const node = state.hub?.nodes.find((n) => n.name === spot.id.slice('rack:'.length));
    if (node) openPanel(openNodeInfo(document.body, node, state.hub?.streams ?? {}));
    return;
  }
  if (spot.id.startsWith('agent:')) {
    const id = Number(spot.id.slice('agent:'.length));
    const agent = state.hub?.agents.find((a) => a.id === id);
    if (agent) void greetAgent(agent);
  }
});

function typingInAnInput(): boolean {
  const element = document.activeElement;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (dialogIsOpen()) closeDialog();
    else if (elevator.state.kind === 'menuOpen') elevator.cancel();
    else closeTopPanel();
    return;
  }
  // Shortcuts stay out of the way of the chat box and of an open text screen.
  if (typingInAnInput() || dialogIsOpen()) return;
  // Number keys are shortcuts, not teleports: they ride the elevator too.
  const floor = FLOORS[Number(event.key) - 1];
  if (floor) elevator.choose(floor.id);
});

connect(store);

let tick = 0;

startLoop(
  (value) => {
    tick = value;
    elevator.tick();
    tickDialog(value);
  },
  () => {
    const state = store.getState();
    const ride = elevator.state;
    const elevatorFrame =
      ride.kind === 'doorsClosing' || ride.kind === 'doorsOpening' ? ride.ticks : undefined;
    renderFloor(screen.ctx, state.floor, state, tick, elevatorFrame);
  },
);
