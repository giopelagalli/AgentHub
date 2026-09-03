import { SPRITES } from '../art/sprites.js';
import type { FloorId } from '../floors.js';
import type { UiState } from '../store.js';
import { drawSprite, drawTilemap } from './draw.js';
import { dynamicFurniture, FLOORPLANS } from './floorplans.js';

/**
 * Ambience is a pure function of the 8fps tick and the sprite's own x, so
 * identical furniture on the same floor animates out of phase without any
 * per-instance state.
 */
function frameFor(anim: string | undefined, tick: number, frames: number, x: number): number {
  switch (anim) {
    // Desks sit on a 72-104px pitch, so x/8 separates neighbouring typists.
    case 'typing':
      return (tick + Math.floor(x / 8)) % frames;
    case 'flicker':
      return tick % 16 === 0 ? 1 : 0;
    case 'vacant':
      return tick % 11 === 0 ? 1 : 0;
    // Racks sit on a 32px pitch: x/32 makes adjacent racks alternate rather
    // than blink in unison (x/16 would land them all on the same parity).
    case 'led':
      return (Math.floor(tick / 2) + Math.floor(x / 32)) % frames;
    case 'twinkle':
      return (Math.floor(tick / 3) + Math.floor(x / 8)) % frames;
    default:
      return 0;
  }
}

/** Idle agents lean back — away from the viewer — by a pixel now and then. */
function bobFor(anim: string | undefined, tick: number, x: number): number {
  if (anim !== 'idle') return 0;
  return (Math.floor(tick / 4) + Math.floor(x / 8)) % 4 === 0 ? -1 : 0;
}

/**
 * Draws one floor: ground tilemap, then furniture in declaration order
 * (painter's algorithm — a robot is listed before the desk it sits behind).
 * Live nodes and agents are appended by `dynamicFurniture`.
 *
 * `elevatorFrame` drives the doors (main.ts computes it every render via
 * `elevatorFrame()`); only callers that omit it — tests — get shut doors.
 */
export function renderFloor(
  ctx: CanvasRenderingContext2D,
  floorId: FloorId,
  state: UiState,
  tick: number,
  elevatorFrame?: number,
): void {
  const plan = FLOORPLANS[floorId];
  drawTilemap(ctx, plan.tilemap, plan.legend);

  for (const item of [...plan.furniture, ...dynamicFurniture(floorId, state)]) {
    const frames = SPRITES[item.sprite];
    if (!frames) continue;
    const pinned = item.sprite === 'elevator' ? (elevatorFrame ?? 0) : item.frame;
    const frame = pinned ?? frameFor(item.anim, tick, frames.length, item.x);
    drawSprite(ctx, frames, item.x, item.y + bobFor(item.anim, tick, item.x), frame);
  }
}
