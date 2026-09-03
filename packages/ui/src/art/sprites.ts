import type { SpriteDef } from './validate.js';

const RACK_LEGEND = { 'D': 'steelDark', 'S': 'steel', 'm': 'mid', 'k': 'ink', 'e': 'ledGreen' };

// The two rack frames light alternate LED banks; the offline rack reuses the
// first bank with the ramp's red so a dead node reads at a glance. 16x32
const RACK_ROWS_A = [
  'DDDDDDDDDDDDDDDD',
  'DSSSSSSSSSSSSSSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
];

const RACK_ROWS_B = [
  'DDDDDDDDDDDDDDDD',
  'DSSSSSSSSSSSSSSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkDDSD',
  'DSkkkkkkkkkkkkSD',
  'DSmmmmmmmmmmmmSD',
  'DSmkkkkkkkkkeeSD',
  'DSkkkkkkkkkkkkSD',
];

const GAUGE_LEGEND = { 'D': 'steelDark', 'S': 'steel', 'k': 'ink', 'o': 'mid', 'e': 'ledGreen' };

/** Wall meter: four segments in a steel bezel, `lit` of them green. 23x8 */
function gaugeFrame(lit: number): SpriteDef {
  const bar = [0, 1, 2, 3].map((i) => (i < lit ? 'eeee' : 'oooo')).join('k');
  const edge = 'D'.repeat(23);
  const rim = `D${'S'.repeat(21)}D`;
  return {
    legend: GAUGE_LEGEND,
    rows: [edge, rim, `DS${'k'.repeat(19)}SD`, `DS${bar}SD`, `DS${bar}SD`, `DS${bar}SD`, rim, edge],
  };
}

const ELEVATOR_LEGEND = {
  'D': 'steelDark', 's': 'steel', 'S': 'steelLit', 'k': 'ink', 'm': 'mid', 'a': 'accentAmber',
  'C': 'cab', 'c': 'cabDark',
};

// Header: floor indicator in a lit bezel. Constant across the door frames.
const ELEVATOR_HEAD = [
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'DSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSD',
  'DSSkkkkkkkkkkkkkkkkkkkkkkkkkkSSD',
  'DSSkkkaaaakkkkmmmmkkkkmmmmkkkSSD',
  'DSSkkkaaaakkkkmmmmkkkkmmmmkkkSSD',
  'DSSkkkkkkkkkkkkkkkkkkkkkkkkkkSSD',
  'DSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSD',
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
];

/** Cab interior, row by row: shadowed ceiling, back wall, handrail, floor. */
function cabRow(y: number, width: number): string {
  if (y === 19) return 'D'.repeat(width);
  const dark = y <= 9 || y === 20 || y >= 27;
  return (dark ? 'c' : 'C').repeat(width);
}

/**
 * Elevator doors. `open` is how far each panel has slid into its wall pocket,
 * in pixels: 0 is shut, 11 leaves a sliver of each panel and the cab wide open.
 * A single glint row crosses both panels so they read as one plane. 32x32
 */
function elevatorDoors(open: number): SpriteDef {
  const rows = [...ELEVATOR_HEAD];
  for (let y = ELEVATOR_HEAD.length; y < 30; y++) {
    // Leading (inner) edge of each panel; the cab shows between them.
    const leftEdge = 14 - open;
    const rightEdge = 17 + open;
    const fill = y === 12 ? 'S' : 's';
    const left = `S${fill.repeat(leftEdge - 3)}D`;
    const right = `S${fill.repeat(28 - rightEdge)}`;
    const cab = `k${cabRow(y, 2 * open)}k`;
    rows.push(`DD${left}${cab}${right}DDD`);
  }
  rows.push('D'.repeat(32), 'D'.repeat(32));
  return { legend: ELEVATOR_LEGEND, rows };
}

/**
 * Every entry is a frame list, so animated and static art share one shape:
 * `SPRITES.desk` is a single frame, `SPRITES.elevator` is four.
 * Frame selection lives in the scene renderer, keyed to the 8fps tick.
 */
export const SPRITES: Record<string, SpriteDef[]> = {
  // Robot agent leaning back at rest. 12x14
  agentIdle: [
    {
      legend: { 's': 'steel', 'S': 'steelLit', 'D': 'steelDark', 'G': 'glassLit', 'g': 'glass', 'b': 'accentBlue', 'c': 'cream' },
      rows: [
        '....ss......',
        '....SS......',
        '..DSSSSSSD..',
        '.DSGGGGGGSD.',
        '.DSGGGGGGSD.',
        '.DSSSSSSSSD.',
        '..DSSSSSSD..',
        '..bbbbbbbb..',
        '..bbbbbbbb..',
        '.SbbccccbbS.',
        '.SbbccccbbS.',
        '..bbbbbbbb..',
        '..DDDDDDDD..',
        '...DDDDDD...',
      ],
    },
  ],
  // Robot agent hammering a keyboard, two-frame loop. 12x14
  agentTyping: [
    {
      legend: { 's': 'steel', 'S': 'steelLit', 'D': 'steelDark', 'G': 'glassLit', 'g': 'glass', 'b': 'accentBlue', 'c': 'cream' },
      rows: [
        '....ss......',
        '....SS......',
        '..DSSSSSSD..',
        '.DSGGGGGGSD.',
        '.DSGGGGGGSD.',
        '.DSSSSSSSSD.',
        '..DSSSSSSD..',
        'S.bbbbbbbb.S',
        '..bbbbbbbb..',
        '..bbccccbb..',
        '..bbccccbb..',
        '..bbbbbbbb..',
        '..DDDDDDDD..',
        '...DDDDDD...',
      ],
    },
    {
      legend: { 's': 'steel', 'S': 'steelLit', 'D': 'steelDark', 'G': 'glassLit', 'g': 'glass', 'b': 'accentBlue', 'c': 'cream' },
      rows: [
        '....ss......',
        '....SS......',
        '..DSSSSSSD..',
        '.DSGGGGGGSD.',
        '.DSggggggSD.',
        '.DSSSSSSSSD.',
        '..DSSSSSSD..',
        '..bbbbbbbb..',
        'S.bbbbbbbb.S',
        '..bbccccbb..',
        '..bbccccbb..',
        '..bbbbbbbb..',
        '..DDDDDDDD..',
        '...DDDDDD...',
      ],
    },
  ],
  // Standard staff desk, two tiles wide. 32x10
  desk: [
    {
      legend: { 'W': 'woodLit', 'w': 'wood', 'V': 'woodDark', 'k': 'ink' },
      rows: [
        'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
        '.kkkkkkkkkkkkkkkkkkkkkkkkkkkkkk.',
      ],
    },
  ],
  // Gilded executive desk for the orchestrator offices. 48x11
  execDesk: [
    {
      legend: { 'W': 'woodLit', 'w': 'wood', 'V': 'woodDark', 'k': 'ink', 'a': 'accentAmber' },
      rows: [
        'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'WwwwaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawwwV',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VwwwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVwwwV',
        'VwwwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVwwwV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Desk monitor; frame 1 is the flicker flash. 12x12
  monitor: [
    {
      legend: { 'S': 'steelLit', 'D': 'steelDark', 'g': 'glass', 'G': 'glassLit' },
      rows: [
        '.SSSSSSSSSS.',
        'SDDDDDDDDDDS',
        'SDggggggggDS',
        'SDgGGGGGGgDS',
        'SDggggggggDS',
        'SDgGGGGGGgDS',
        'SDggggggggDS',
        'SDDDDDDDDDDS',
        '.SSSSSSSSSS.',
        '....SSSS....',
        '...SSSSSS...',
        '..DDDDDDDD..',
      ],
    },
    {
      legend: { 'S': 'steelLit', 'D': 'steelDark', 'g': 'glass', 'G': 'glassLit' },
      rows: [
        '.SSSSSSSSSS.',
        'SDDDDDDDDDDS',
        'SDGGGGGGGGDS',
        'SDGGGGGGGGDS',
        'SDGGGGGGGGDS',
        'SDGGGGGGGGDS',
        'SDGGGGGGGGDS',
        'SDDDDDDDDDDS',
        '.SSSSSSSSSS.',
        '....SSSS....',
        '...SSSSSS...',
        '..DDDDDDDD..',
      ],
    },
  ],
  // Server rack; the two frames alternate blade LEDs. 16x32
  rack: [
    { legend: RACK_LEGEND, rows: RACK_ROWS_A },
    { legend: RACK_LEGEND, rows: RACK_ROWS_B },
  ],
  // Dead node: same chassis, LEDs stuck on the ramp's red. 16x32
  rackOffline: [{ legend: { ...RACK_LEGEND, 'e': 'accentRed' }, rows: RACK_ROWS_A }],
  // Per-tier stream gauge; frame index is the number of active streams. 23x8
  gauge: [gaugeFrame(0), gaugeFrame(1), gaugeFrame(2), gaugeFrame(3), gaugeFrame(4)],
  // Elevator doors: four frames part from shut to wide open. 32x32
  elevator: [elevatorDoors(0), elevatorDoors(4), elevatorDoors(8), elevatorDoors(11)],
  // Lobby reception counter with a brass placard. 48x14
  reception: [
    {
      legend: { 'W': 'woodLit', 'w': 'wood', 'V': 'woodDark', 'k': 'ink', 'c': 'cream', 'a': 'accentAmber' },
      rows: [
        'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'WwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VwwwwwkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkwwwwwV',
        'VwwwwwkcccccccccccccccccccccccccccccccccckwwwwwV',
        'VwwwwwkccccaaaaaaaaaaaaaaaaaaaaaaaaaacccckwwwwwV',
        'VwwwwwkcccccccccccccccccccccccccccccccccckwwwwwV',
        'VwwwwwkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkwwwwwV',
        'VwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Free-standing job board kiosk. 16x20
  kiosk: [
    {
      legend: { 'D': 'steelDark', 'S': 'steel', 'g': 'glass', 'G': 'glassLit', 'k': 'ink' },
      rows: [
        'DDDDDDDDDDDDDDDD',
        'DSSSSSSSSSSSSSSD',
        'DSggggggggggggSD',
        'DSgGGGGGGGGGGgSD',
        'DSggggggggggggSD',
        'DSgGGGGGGGGGGgSD',
        'DSggggggggggggSD',
        'DSgGGGGGGGGGGgSD',
        'DSggggggggggggSD',
        'DSSSSSSSSSSSSSSD',
        'DDDDDDDDDDDDDDDD',
        '......DDDD......',
        '......DSSD......',
        '......DSSD......',
        '......DSSD......',
        '......DSSD......',
        '....DDDDDDDD....',
        '....DSSSSSSD....',
        '....DDDDDDDD....',
        '....kkkkkkkk....',
      ],
    },
  ],
  // Wall-mounted floor directory. 24x18
  directoryBoard: [
    {
      legend: { 'V': 'woodDark', 'W': 'woodLit', 'c': 'cream', 'k': 'ink', 'a': 'accentAmber' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVV',
        'VWWWWWWWWWWWWWWWWWWWWWWV',
        'VWccccccccccccccccccccWV',
        'VWcckkkkkkkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWccaaaackkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWccaaaackkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWccaaaackkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWccaaaackkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWccaaaackkkkkkkkkkkccWV',
        'VWccccccccccccccccccccWV',
        'VWWWWWWWWWWWWWWWWWWWWWWV',
        'VVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Pinboard of task cards. 32x18
  taskboard: [
    {
      legend: { 'V': 'woodDark', 'W': 'woodLit', 'k': 'ink', 'a': 'accentAmber', 'r': 'accentRed', 'b': 'accentBlue', 'c': 'cream' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWV',
        'VWkkkkkkkkkkkkkkkkkkkkkkkkkkkkWV',
        'VWkkaaaaaakkkrrrrrrkkkbbbbbbkkWV',
        'VWkkaaaaaakkkrrrrrrkkkbbbbbbkkWV',
        'VWkkaaaaaakkkrrrrrrkkkbbbbbbkkWV',
        'VWkkkkkkkkkkkkkkkkkkkkkkkkkkkkWV',
        'VWkkcccccckkkaaaaaakkkcccccckkWV',
        'VWkkcccccckkkaaaaaakkkcccccckkWV',
        'VWkkcccccckkkaaaaaakkkcccccckkWV',
        'VWkkkkkkkkkkkkkkkkkkkkkkkkkkkkWV',
        'VWkkbbbbbbkkkcccccckkkrrrrrrkkWV',
        'VWkkbbbbbbkkkcccccckkkrrrrrrkkWV',
        'VWkkbbbbbbkkkcccccckkkrrrrrrkkWV',
        'VWkkkkkkkkkkkkkkkkkkkkkkkkkkkkWV',
        'VWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Penthouse briefing slate in a gilt frame. 32x20
  briefingBoard: [
    {
      legend: { 'a': 'accentAmber', 'V': 'woodDark', 'k': 'ink', 'c': 'cream' },
      rows: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkcccccccccccccccccccccccckkVa',
        'aVkkcccccccccccccccccccccccckkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkaaaaaaaaaaaaaaaaaakkkkkkkkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkaaaaaaaaaaaaaaaaaaaaaakkkkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkaaaaaaaaaaaaaakkkkkkkkkkkkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkcccccccccccccccccccckkkkkkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVkkaaaaaaaaaaaaaaaakkkkkkkkkkVa',
        'aVkkkkkkkkkkkkkkkkkkkkkkkkkkkkVa',
        'aVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Penthouse lounge rug, gold border and cream inlay. 64x40
  rug: [
    {
      legend: { 'a': 'accentAmber', 'V': 'woodDark', 'm': 'mid', 'c': 'cream', 'k': 'ink' },
      rows: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVa',
        'aVmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmVa',
        'aVmmmccccccccccccccccccccccccccccccccccccccccccccccccccccccmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmcmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmcmmmVa',
        'aVmmmccccccccccccccccccccccccccccccccccccccccccccccccccccccmmmVa',
        'aVmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmVa',
        'aVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      ],
    },
  ],
  // Upholstered armchair with amber piping. 20x15
  armchair: [
    {
      legend: { 'V': 'woodDark', 'm': 'mid', 'l': 'lit', 'a': 'accentAmber', 'k': 'ink' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVV',
        'VmmmmmmmmmmmmmmmmmmV',
        'VmllllllllllllllllmV',
        'VmllllllllllllllllmV',
        'VmllllllllllllllllmV',
        'VmmmmmmmmmmmmmmmmmmV',
        'VaaaaaaaaaaaaaaaaaaV',
        'VVVVVVVVVVVVVVVVVVVV',
        'VVVmmmmmmmmmmmmmmVVV',
        'VmVllllllllllllllVmV',
        'VmVllllllllllllllVmV',
        'VmVllllllllllllllVmV',
        'VVVmmmmmmmmmmmmmmVVV',
        'VVVVVVVVVVVVVVVVVVVV',
        '.kkkkkkkkkkkkkkkkkk.',
      ],
    },
  ],
  // Glass-topped lounge table. 28x9
  coffeeTable: [
    {
      legend: { 'W': 'woodLit', 'V': 'woodDark', 'g': 'glass', 'G': 'glassLit', 'k': 'ink' },
      rows: [
        'WWWWWWWWWWWWWWWWWWWWWWWWWWWW',
        'WggggggggggggggggggggggggggV',
        'WGGGGGGGGGGGGGGGGGGGGGGGGGGV',
        'WggggggggggggggggggggggggggV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        '..VV....................VV..',
        '..VV....................VV..',
        '..VV....................VV..',
        '.kkkkkkkkkkkkkkkkkkkkkkkkkk.',
      ],
    },
  ],
  // Standing lamp with a lit shade. 12x32
  floorLamp: [
    {
      legend: { 'a': 'accentAmber', 'y': 'warm', 'c': 'cream', 'W': 'woodLit', 'V': 'woodDark', 'k': 'ink' },
      rows: [
        '..aaaaaaaa..',
        '.aaaaaaaaaa.',
        '.ayyyyyyyya.',
        'ayyyyyyyyyya',
        'ayyccccccyya',
        'ayyccccccyya',
        'ayyyyyyyyyya',
        '.aaaaaaaaaa.',
        '....WWWW....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '.....WW.....',
        '...VVVVVV...',
        '..VVVVVVVV..',
        '..VVVVVVVV..',
        '...kkkkkk...',
      ],
    },
  ],
  // FOR LEASE sign on a post. 32x24
  forLease: [
    {
      legend: { 'V': 'woodDark', 'W': 'woodLit', 'c': 'cream', 'k': 'ink' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWV',
        'VWccccccccccccccccccccccccccccWV',
        'VWccccccccccccccccccccccccccccWV',
        'VWcccccccckkkckkkckkccccccccccWV',
        'VWcccccccckccckckckckcccccccccWV',
        'VWcccccccckkcckckckkccccccccccWV',
        'VWcccccccckccckckckckcccccccccWV',
        'VWcccccccckccckkkckckcccccccccWV',
        'VWccccccccccccccccccccccccccccWV',
        'VWcccckccckkkcckcckkkckkkcccccWV',
        'VWcccckccckccckckckccckcccccccWV',
        'VWcccckccckkcckkkckkkckkccccccWV',
        'VWcccckccckccckckccckckcccccccWV',
        'VWcccckkkckkkckckckkkckkkcccccWV',
        'VWccccccccccccccccccccccccccccWV',
        'VWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        '..............VVVV..............',
        '..............VVVV..............',
        '..............VVVV..............',
        '..............VVVV..............',
        '..............VVVV..............',
        '............kkkkkkkk............',
      ],
    },
  ],
  // Strip light; frame 1 is the dropout of the flicker. 32x12
  ceilingLight: [
    {
      legend: { 'D': 'steelDark', 'S': 'steel', 'm': 'mid', 'c': 'cream', 'y': 'warm' },
      rows: [
        '......DDDDDDDDDDDDDDDDDDDD......',
        '......DSSSSSSSSSSSSSSSSSSD......',
        '......DSDDDDDDDDDDDDDDDDSD......',
        '......DSDccccccccccccccDSD......',
        '......DSDyyyyyyyyyyyyyyDSD......',
        '......DSDDDDDDDDDDDDDDDDSD......',
        '......DSSSSSSSSSSSSSSSSSSD......',
        '......DDDDDDDDDDDDDDDDDDDD......',
        '.....yyyyyyyyyyyyyyyyyyyyyy.....',
        '...y.y.y.y.y.y.y.y.y.y.y.y.y....',
        '..y...y...y...y...y...y...y.....',
        '......y...y...y...y...y...y.....',
      ],
    },
    {
      legend: { 'D': 'steelDark', 'S': 'steel', 'm': 'mid', 'c': 'cream', 'y': 'warm' },
      rows: [
        '......DDDDDDDDDDDDDDDDDDDD......',
        '......DSSSSSSSSSSSSSSSSSSD......',
        '......DSDDDDDDDDDDDDDDDDSD......',
        '......DSDmmmmmmmmmmmmmmDSD......',
        '......DSDmmmmmmmmmmmmmmDSD......',
        '......DSDDDDDDDDDDDDDDDDSD......',
        '......DSSSSSSSSSSSSSSSSSSD......',
        '......DDDDDDDDDDDDDDDDDDDD......',
        '................................',
        '................................',
        '................................',
        '................................',
      ],
    },
  ],
  // Potted plant. 12x16
  plant: [
    {
      legend: { 'l': 'lit', 'm': 'mid', 'V': 'woodDark', 'W': 'woodLit', 'w': 'wood', 'k': 'ink' },
      rows: [
        '....lll.....',
        '..lllllll...',
        '.lllllllll..',
        'lllllmlllll.',
        '.lllmllllll.',
        '..lllllll...',
        '...mllll....',
        '.....mm.....',
        '.....mm.....',
        '...VVVVVV...',
        '...WWWWWW...',
        '...WwwwwW...',
        '...WwwwwW...',
        '....WwwW....',
        '....VVVV....',
        '...kkkkkk...',
      ],
    },
  ],
  // Penthouse window strip, left pane. 32x24
  windowPaneL: [
    {
      legend: { 'V': 'woodDark', 'a': 'accentAmber', 'n': 'night', 't': 'star', 'k': 'ink' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnntnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnntnnnnnnnnnaV',
        'VannntnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnntnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnkkkkkknnnnnnnnnnnaV',
        'VannnnnnnnnnnkakakannnnnnnnnnnaV',
        'VannkkkkkkknnkkkkkknnnnnnnnnnnaV',
        'VannkakakaknnkkkkkknnnnnnnnnnnaV',
        'VannkkkkkkknnkakakannnnnnnnnnnaV',
        'VannkakakaknnkkkkkknkkkkkkknnnaV',
        'VannkkkkkkknnkakakankakakaknnnaV',
        'VannkakakaknnkkkkkknkkkkkkknnnaV',
        'VannkkkkkkknnkkkkkknkakakaknnnaV',
        'VannkakakaknnkakakankkkkkkknnnaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      ],
    },
  ],
  // Penthouse window strip, centre pane. 32x24
  windowPaneC: [
    {
      legend: { 'V': 'woodDark', 'a': 'accentAmber', 'n': 'night', 't': 'star', 'k': 'ink' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnntnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VanntnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnntnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnntnnnnnnnnnnnnnaV',
        'VannnkkkkknnnnnnnnnnnnnnnnnnnnaV',
        'VannnkakaknnnnnnnnnnnnnnnnnnnnaV',
        'VannnkkkkknnnnnnnnnnnnnnnnnnnnaV',
        'VannnkakaknnnnkkkkkkkknnnnnnnnaV',
        'VannnkkkkknnnnkakakakannnnnnnnaV',
        'VannnkakaknnnnkkkkkkkknnkkkkknaV',
        'VannnkkkkknnnnkakakakannkakaknaV',
        'VannnkakaknnnnkkkkkkkknnkkkkknaV',
        'VannnkkkkknnnnkakakakannkakaknaV',
        'VannnkakaknnnnkkkkkkkknnkkkkknaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      ],
    },
  ],
  // Penthouse window strip, right pane. 32x24
  windowPaneR: [
    {
      legend: { 'V': 'woodDark', 'a': 'accentAmber', 'n': 'night', 't': 'star', 'k': 'ink' },
      rows: [
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnntnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnntnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnntnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnnnnnnnnnnnnnnnnnnnnaV',
        'VannnnnnnnnkkkkkkkkknnnnnnnnnnaV',
        'VannnnnnnnnkakakakaknkkkkknnnnaV',
        'VannnnnnnnnkkkkkkkkknkakaknnnnaV',
        'VankkkkkknnkakakakaknkkkkknnnnaV',
        'VankakakannkkkkkkkkknkakaknnnnaV',
        'VankkkkkknnkakakakaknkkkkknnnnaV',
        'VankakakannkkkkkkkkknkakaknnnnaV',
        'VankkkkkknnkakakakaknkkkkknnnnaV',
        'VankakakannkkkkkkkkknkakaknnnnaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VankkkkkkkkkkkkkkkkkkkkkkkkkknaV',
        'VaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaV',
        'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      ],
    },
  ],
  // Star twinkle on the penthouse skyline: bright, small, out. 3x3
  twinkle: [
    {
      legend: { 't': 'star' },
      rows: [
        '.t.',
        'ttt',
        '.t.',
      ],
    },
    {
      legend: { 't': 'star' },
      rows: [
        '...',
        '.t.',
        '...',
      ],
    },
    {
      legend: { 't': 'star' },
      rows: [
        '...',
        '...',
        '...',
      ],
    },
  ],
};
