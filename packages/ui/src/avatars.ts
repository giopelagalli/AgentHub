import { AVATARS, type Avatar } from '@agenthub/shared';

/**
 * The six employee avatars: 16x16 pixel-art robot busts, one per id in `AVATARS`.
 *
 * Each is authored as sixteen rows of sixteen characters — the grid is the art,
 * and reading it down the page is how you see the silhouette. Chassis chars are
 * shared so the six read as one production run; `a`/`b` are the robot's own
 * neon, which is what actually tells them apart at 32px, together with the
 * headgear: a dish, a crest, a monocle, a halo, an aerial, twin stubs.
 */

/** Chassis ramp — the same blued chrome on every unit. */
const CHASSIS: Record<string, string> = {
  k: '#050410', // outline
  d: '#14202c', // shadowed plate
  m: '#2e4459', // plate
  l: '#6f93ad', // lit edge
  s: '#0e2c3d', // glass behind the eyes
};

/** Per-robot neon: the lamp colour (`a`) and its hot core (`b`). */
const NEON: Record<Avatar, { a: string; b: string }> = {
  'robot-cyan': { a: '#22e0ff', b: '#b9f6ff' },
  'robot-magenta': { a: '#ff2d95', b: '#ffb3da' },
  'robot-amber': { a: '#ffb43c', b: '#ffe2a8' },
  'robot-violet': { a: '#b46bff', b: '#e3c8ff' },
  'robot-green': { a: '#39ff88', b: '#c3ffd9' },
  'robot-white': { a: '#dfe9ff', b: '#ffffff' },
};

/** Dish-antenna scout: one wide visor, a mast and dish over the left shoulder. */
const CYAN = [
  '..bb............',
  '.baab...........',
  '..aa............',
  '...aa...........',
  '....kddddddk....',
  '...kdmmmmmmmdk..',
  '...kdaaaaaaadk..',
  '...kdabbbbbadk..',
  '...kdmmmmmmmdk..',
  '...kdmlmmmlmdk..',
  '....kdmmmmmdk...',
  '.....kkdmdkk....',
  '...kkmmdmdmmkk..',
  '..kmmmlmamlmmmk.',
  '..kmmmmmmmmmmmk.',
  '..kkkkkkkkkkkkk.',
];

/** Crested signaller: a fin between two ear cups, twin eyes, a mouth grille. */
const MAGENTA = [
  '.......bb.......',
  '......kaaak.....',
  '......kaaak.....',
  '....kkdddddkk...',
  '...kdmmmmmmmdk..',
  '..kakdmmmmmdkak.',
  '..kabdaasaadbak.',
  '..kakdbbsbbdkak.',
  '...kdmmmmmmmdk..',
  '...kdmaaaaamdk..',
  '....kdmmmmmdk...',
  '.....kkdmdkk....',
  '...kkmmmdmmmkk..',
  '..kmmmammmammmk.',
  '..kmmmmmmmmmmmk.',
  '..kkkkkkkkkkkkk.',
];

/** Welder: a heavy flat-topped head, an eye band on one side, a monocle on the other. */
const AMBER = [
  '................',
  '...kk......kk...',
  '..kddkkkkkkddk..',
  '..kdddddddddddk.',
  '..kdmmmmmmmmmdk.',
  '..kdaaammkbbbkd.',
  '..kdabbmmkbabkd.',
  '..kdmmmmmmmmmdk.',
  '..kdmkmkmkmkmdk.',
  '..kdmkmkmkmkmdk.',
  '..kddddddddddk..',
  '....kkdmmdkk....',
  '..kkmmmdddmmmkk.',
  '.kmmmammmmmammmk',
  '.kmmmmmmmmmmmmmk',
  '.kkkkkkkkkkkkkkk',
];

/** Thinker: a tall dome under a floating halo, three sensor slits for a face. */
const VIOLET = [
  '....kbaaabk.....',
  '.....l...l......',
  '.....kdddk......',
  '....kdmmmdk.....',
  '...kdmmmmmdk....',
  '..kdmmmmmmmdk...',
  '..kdmamamamdk...',
  '..kdmbmbmbmdk...',
  '..kdmamamamdk...',
  '..kdmmmmmmmdk...',
  '...kdmmmmmdk....',
  '....kkdmdkk.....',
  '..kkmmmdmmmkk...',
  '.kmmmmmamammmmk.',
  '.kmmmmmmmmmmmmk.',
  '.kkkkkkkkkkkkkk.',
];

/** Drone head: a squat trapezoid, a split scanner bar, an aerial off the right temple. */
const GREEN = [
  '............b...',
  '...........kak..',
  '...........kak..',
  '....kddddddkak..',
  '...kdmmmmmmdkk..',
  '..kdmmmmmmmmdk..',
  '..kdaaaadaaaadk.',
  '..kdbbbbdbbbbdk.',
  '..kdmmmmmmmmmdk.',
  '..kdmmmmmmmmmdk.',
  '..kdddddddddddk.',
  '.....kkdmdkk....',
  '...kkmmmdmmmkk..',
  '..kmmmmmammmmmk.',
  '..kmmmmmmmmmmmk.',
  '..kkkkkkkkkkkkk.',
];

/** Courier: chrome plate, a split visor across the whole face, two stub antennae. */
const WHITE = [
  '...b........b...',
  '...l........l...',
  '...l.kkkkkk.l...',
  '...kkdddddddkk..',
  '..kdlllllllllk..',
  '..kdaaaaaaaaadk.',
  '..kdddddddddddk.',
  '..kdbbbbbbbbbdk.',
  '..kdlllllllllk..',
  '..kdmmmmmmmmmdk.',
  '..kddddddddddk..',
  '....kkdmmdkk....',
  '..kklllmmlllkk..',
  '.kllmmmmmmmmllk.',
  '.kmmmmmmmmmmmmk.',
  '.kkkkkkkkkkkkkk.',
];

const GRIDS: Record<Avatar, string[]> = {
  'robot-cyan': CYAN,
  'robot-magenta': MAGENTA,
  'robot-amber': AMBER,
  'robot-violet': VIOLET,
  'robot-green': GREEN,
  'robot-white': WHITE,
};

export const AVATAR_SIZE = 16;

/** True for any string the roster might carry in `avatar`; unknown ones fall back. */
export function isAvatar(id: string): id is Avatar {
  return (AVATARS as readonly string[]).includes(id);
}

/** The 16 rows of `id`, or the cyan scout's when the roster names something we don't draw. */
export function avatarRows(id: string): string[] {
  return GRIDS[isAvatar(id) ? id : 'robot-cyan'];
}

/** The colour every character of `id`'s grid paints, '.' excluded. */
export function avatarPalette(id: string): Record<string, string> {
  const neon = NEON[isAvatar(id) ? id : 'robot-cyan'];
  return { ...CHASSIS, a: neon.a, b: neon.b };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Paints one bust as an inline SVG, sized in CSS pixels. Runs of the same
 * character become one rect, which keeps a 16x16 bust to a few dozen nodes.
 */
export function avatarSvg(id: string, size = 32): SVGSVGElement {
  const rows = avatarRows(id);
  const palette = avatarPalette(id);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('avatar');

  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === char) run++;
      const fill = palette[char];
      if (fill) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(run));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', fill);
        svg.appendChild(rect);
      }
      x += run;
    }
  });

  return svg;
}
