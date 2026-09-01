import { startLoop } from './engine/loop.js';
import { Screen } from './engine/screen.js';
import { FLOORS } from './floors.js';
import { renderFloor } from './render/scene.js';
import { Store } from './store.js';

const app = document.getElementById('app');
if (!app) throw new Error('#app host element not found');

const screen = new Screen(app);
const store = new Store();

// Temporary for Task 3: keys 1-6 walk the tower. Task 4 replaces this with the
// elevator panel driven by hotspot clicks.
window.addEventListener('keydown', (event) => {
  const floor = FLOORS[Number(event.key) - 1];
  if (floor) store.dispatch({ type: 'set-floor', floor: floor.id });
});

let tick = 0;

startLoop(
  (value) => {
    tick = value;
  },
  () => {
    const state = store.getState();
    renderFloor(screen.ctx, state.floor, state, tick);
  },
);
