import { Screen } from './engine/screen.js';
import { startLoop } from './engine/loop.js';
import { PALETTE } from './art/palette.js';

const app = document.getElementById('app');
if (!app) throw new Error('#app host element not found');

const screen = new Screen(app);
const { ctx } = screen;

function render(): void {
  ctx.fillStyle = PALETTE.bg0;
  ctx.fillRect(0, 0, 320, 288);
  ctx.fillStyle = PALETTE.cream;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AGENTHUB', 160, 144);
}

startLoop(
  () => {},
  () => render(),
);
