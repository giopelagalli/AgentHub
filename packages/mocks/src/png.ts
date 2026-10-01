import { crc32, deflateSync } from 'node:zlib';

/** One RGB pixel, each channel 0–255. */
export type Rgb = [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A real, viewable 8-bit RGB PNG drawn by `pixel` — what the ComfyUI mock and the simulation hand
 * out as "rendered" stills, so the UI's thumbnails show something rather than a broken image.
 */
export function pngBytes(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as Rgb;

/**
 * A two-colour diagonal gradient with a pale disc in the middle, its hues taken from `text` —
 * different prompts, different pictures, and every one reads as "a rendered image" in a grid.
 */
export function gradientPng(text: string, size = 128): Buffer {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const a: Rgb = [h & 255, (h >> 8) & 255, (h >> 16) & 255];
  const b: Rgb = [255 - a[1], a[2], 255 - a[0]];
  const c = (size - 1) / 2;
  return pngBytes(size, size, (x, y) => {
    const ground = mix(a, b, (x + y) / (2 * (size - 1)));
    // A disc of radius 0.28·size with a one-pixel soft edge.
    const edge = Math.min(1, Math.max(0, size * 0.28 - Math.hypot(x - c, y - c)));
    return mix(ground, mix(ground, [255, 255, 255], 0.8), edge);
  });
}
