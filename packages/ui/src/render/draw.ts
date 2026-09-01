import { PALETTE } from '../art/palette.js';
import { TILE_SIZE, TILES } from '../art/tiles.js';
import type { SpriteDef } from '../art/validate.js';

/**
 * Matrices are expanded to a 1:1 offscreen canvas once and blitted thereafter:
 * a full screen is ~360 tile blits per frame instead of ~92k pixel fills.
 */
const baked = new WeakMap<SpriteDef, HTMLCanvasElement>();

function bake(def: SpriteDef): HTMLCanvasElement {
  const cached = baked.get(def);
  if (cached) return cached;

  const height = def.rows.length;
  const width = height > 0 ? def.rows[0].length : 0;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable for sprite bake');

  for (let y = 0; y < height; y++) {
    const row = def.rows[y];
    for (let x = 0; x < width; x++) {
      const char = row[x];
      if (char === '.') continue;
      ctx.fillStyle = PALETTE[def.legend[char]];
      ctx.fillRect(x, y, 1, 1);
    }
  }

  baked.set(def, canvas);
  return canvas;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  def: SpriteDef | SpriteDef[],
  x: number,
  y: number,
  frame = 0,
): void {
  const frames = Array.isArray(def) ? def : [def];
  if (frames.length === 0) return;
  const index = ((frame % frames.length) + frames.length) % frames.length;
  ctx.drawImage(bake(frames[index]), x, y);
}

export function drawTilemap(
  ctx: CanvasRenderingContext2D,
  map: string[],
  legend: Record<string, string>,
): void {
  for (let row = 0; row < map.length; row++) {
    const line = map[row];
    for (let col = 0; col < line.length; col++) {
      const tile = TILES[legend[line[col]]];
      if (!tile) continue;
      ctx.drawImage(bake(tile), col * TILE_SIZE, row * TILE_SIZE);
    }
  }
}
