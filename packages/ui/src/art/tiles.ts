import type { SpriteDef } from './validate.js';

export const TILE_SIZE = 16;

// Shared legends. Tiles are always fully opaque: the tilemap is the ground layer.
const WALL = { b: 'bg0', k: 'ink', m: 'mid', l: 'lit', p: 'pale' } as const;
const WALL_DARK = { k: 'ink', D: 'steelDark', s: 'steel', S: 'steelLit' } as const;

/**
 * 16x16 ground and wall tiles, drawn in a Gen-2 three-quarter interior view:
 * row 0 of a floor is the ceiling shadow + crown, row 1 the wall face,
 * row 2 the wall face meeting its baseboard, everything below is ground.
 */
export const TILES: Record<string, SpriteDef> = {
  // Ceiling shadow above the back wall, capped with a crown moulding highlight.
  wallTop: {
    legend: WALL,
    rows: [
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbb',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
      'mmmmmmmmmmmmmmmm',
      'pppppppppppppppp',
      'llllllllllllllll',
      'llllllllllllllll',
    ],
  },

  // Painted wall face with a panel seam every tile.
  wallFace: {
    legend: WALL,
    rows: [
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
    ],
  },

  // Wall face resolving into a lit rail and a dark baseboard.
  wallBase: {
    legend: WALL,
    rows: [
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'mlllllllllllllll',
      'pppppppppppppppp',
      'pppppppppppppppp',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
    ],
  },

  // Room's side wall, seen edge on and in shadow: deliberately much darker
  // than `carpet` so it still reads as a wall on the carpeted floors.
  wallSide: {
    legend: WALL,
    rows: [
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
      'kmkkkkkkkkkkkkmk',
    ],
  },

  // Interior partition seen edge on. Painted in the same ramp as `wallFace` /
  // `wallBase` so an L-shaped office reads as one continuous wall.
  partitionSide: {
    legend: WALL,
    rows: [
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
      'kmlllllllllllpmk',
    ],
  },

  wallSideDark: {
    legend: WALL_DARK,
    rows: [
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
      'kDDDDDDDDDDDDDDD',
    ],
  },

  // Basement equivalents: bare steel panelling instead of paint.
  wallFaceDark: {
    legend: WALL_DARK,
    rows: [
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
    ],
  },

  wallBaseDark: {
    legend: WALL_DARK,
    rows: [
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'Dsssssssssssssss',
      'SSSSSSSSSSSSSSSS',
      'DDDDDDDDDDDDDDDD',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
      'kkkkkkkkkkkkkkkk',
    ],
  },

  // Lobby / penthouse hard flooring: polished stone, jointed every tile.
  floorCream: {
    legend: { p: 'stoneLit', c: 'stone' },
    rows: [
      'pppppppppppppppp',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
      'pccccccccccccccc',
    ],
  },

  // The lobby's carpet runner: deep magenta plush with a lit edge.
  floorPale: {
    legend: { l: 'plush', p: 'plushDark' },
    rows: [
      'llllllllllllllll',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
      'lppppppppppppppp',
    ],
  },

  // Office carpet with a sparse woven fleck.
  carpet: {
    legend: { m: 'mid', l: 'midDark' },
    rows: [
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmlmmmmmmmlmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmlmmmmmmmlm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
      'mmmmmmmmmmmmmmmm',
    ],
  },

  // Penthouse: dark polished stone with a gilded stud at every joint.
  carpetFancy: {
    legend: { k: 'ink', m: 'mid', a: 'accentAmber' },
    rows: [
      'mmmmmmmmmmmmmmmm',
      'makkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
      'mkkkkkkkkkkkkkkk',
    ],
  },

  // Basement: riveted steel deck plate.
  floorGrid: {
    legend: { k: 'ink', d: 'bg1', m: 'mid' },
    rows: [
      'kkkkkkkkkkkkkkkk',
      'kmdddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
      'kddddddddddddddd',
    ],
  },

  // Vacant floor: unfinished screed with faint pour joints.
  floorBare: {
    legend: { m: 'dustDark', u: 'dust' },
    rows: [
      'mmmmmmmmmmmmmmmm',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
      'muuuuuuuuuuuuuuu',
    ],
  },
};
