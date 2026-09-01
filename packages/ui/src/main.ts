import './panels/panels.css';
import { PALETTE } from './art/palette.js';
import { Elevator } from './elevator.js';
import { bindPointer } from './engine/input.js';
import { startLoop } from './engine/loop.js';
import { Screen } from './engine/screen.js';
import { FLOORS } from './floors.js';
import { connect } from './net.js';
import { openElevatorMenu } from './panels/elevator.js';
import { openNodeInfo } from './panels/nodeinfo.js';
import { openQueuePanel } from './panels/queue.js';
import { hotspotsFor } from './render/floorplans.js';
import { renderFloor } from './render/scene.js';
import { Store } from './store.js';

const app = document.getElementById('app');
if (!app) throw new Error('#app host element not found');

// The panel stylesheet reads the canvas palette through these.
for (const [name, hex] of Object.entries(PALETTE)) {
  document.documentElement.style.setProperty(`--c-${name}`, hex);
}

const screen = new Screen(app);
const store = new Store();

/** Informational panels, newest last: Esc closes the one on top. */
const panels: (() => void)[] = [];

function openPanel(close: () => void): void {
  panels.push(close);
}

function closeTopPanel(): void {
  panels.pop()?.();
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

bindPointer(screen.canvas, (x, y) => {
  if (elevator.state.kind !== 'idle') return;
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
  if (spot.id.startsWith('rack:')) {
    const node = state.hub?.nodes.find((n) => n.name === spot.id.slice('rack:'.length));
    if (node) openPanel(openNodeInfo(document.body, node, state.hub?.streams ?? {}));
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (elevator.state.kind === 'menuOpen') elevator.cancel();
    else closeTopPanel();
    return;
  }
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
  },
  () => {
    const state = store.getState();
    const ride = elevator.state;
    const elevatorFrame =
      ride.kind === 'doorsClosing' || ride.kind === 'doorsOpening' ? ride.ticks : undefined;
    renderFloor(screen.ctx, state.floor, state, tick, elevatorFrame);
  },
);
