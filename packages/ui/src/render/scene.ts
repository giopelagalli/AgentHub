import { SPRITES } from '../art/sprites.js';
import type { FloorId } from '../floors.js';
import type { UiState } from '../store.js';
import { drawSprite, drawTilemap } from './draw.js';
import { FLOORPLANS } from './floorplans.js';

/**
 * Ambience is a pure function of the 8fps tick and the sprite's own x, so
 * identical furniture on the same floor animates out of phase without any
 * per-instance state.
 */
function frameFor(anim: string | undefined, tick: number, frames: number, x: number): number {
  switch (anim) {
    case 'typing':
      return tick % frames;
    case 'flicker':
      return tick % 16 === 0 ? 1 : 0;
    case 'vacant':
      return tick % 11 === 0 ? 1 : 0;
    case 'led':
      return (Math.floor(tick / 2) + Math.floor(x / 16)) % frames;
    case 'elevator':
      return Math.floor(tick / 4) % frames;
    case 'twinkle':
      return (Math.floor(tick / 3) + Math.floor(x / 8)) % frames;
    default:
      return 0;
  }
}

/** Idle agents sway back by a pixel every couple of seconds. */
function bobFor(anim: string | undefined, tick: number, x: number): number {
  if (anim !== 'idle') return 0;
  return (Math.floor(tick / 4) + Math.floor(x / 8)) % 4 === 0 ? 1 : 0;
}

/**
 * Draws one floor: ground tilemap, then furniture in declaration order
 * (painter's algorithm — a robot is listed before the desk it sits behind).
 * `state` is unused until Task 4 replaces the placeholder racks and desks
 * with live nodes and agents.
 */
export function renderFloor(
  ctx: CanvasRenderingContext2D,
  floorId: FloorId,
  state: UiState,
  tick: number,
): void {
  void state;
  const plan = FLOORPLANS[floorId];
  drawTilemap(ctx, plan.tilemap, plan.legend);

  for (const item of plan.furniture) {
    const frames = SPRITES[item.sprite];
    if (!frames) continue;
    const frame = frameFor(item.anim, tick, frames.length, item.x);
    drawSprite(ctx, frames, item.x, item.y + bobFor(item.anim, tick, item.x), frame);
  }
}
