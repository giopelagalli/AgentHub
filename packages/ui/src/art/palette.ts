/**
 * Cyberpunk tower palette. Every colour on the canvas and in the DOM panels
 * comes from here — sprites and tiles reference the names, never the hex.
 *
 * The structural ramp (bg0 → cream) is one cool violet/indigo family, ordered
 * dark to light so tiles and sprites keep their silhouettes; it stays muted on
 * purpose. The neon lives in the accents — magenta, cyan, amber, LED green —
 * which cover small areas and read as light sources against the dark rooms.
 */
export const PALETTE: Record<string, string> = {
  bg0: '#07060f',
  bg1: '#120b22',
  ink: '#1a1030',
  mid: '#2c1a4d',
  midDark: '#241340',
  lit: '#46306f',
  pale: '#7c8ac0',
  cream: '#aebbe6',
  // Neon signage: hot magenta, electric cyan, sodium amber.
  accentRed: '#ff2d95',
  accentBlue: '#22e0ff',
  accentAmber: '#ffb43c',
  // Cool machine ramp: racks, elevator doors, monitor chassis — blued chrome.
  steelDark: '#14202c',
  steel: '#2e4459',
  steelLit: '#6f93ad',
  // Elevator cab seen past the open doors: back wall, then its deep shadow.
  cab: '#0a1622',
  cabDark: '#04090f',
  // Synthetic timber ramp: desks, reception, boards, planters. Near-black
  // composite lifted by an amber edge light, so a desk still reads as a desk.
  woodDark: '#2b1d20',
  wood: '#6b4a36',
  woodLit: '#d89550',
  // Lobby / penthouse hard flooring: polished dark stone and its joint lines.
  stone: '#1e1a33',
  stoneLit: '#2f2a52',
  // Glass: monitor and kiosk screens, lit from inside.
  glass: '#0e2c3d',
  glassLit: '#3df0ff',
  // Penthouse night window: deep indigo, pink beacons over the skyline.
  night: '#0c0a24',
  star: '#ff9bea',
  // Screening-room plush: sofa shadow, body, and the light catching its back.
  plushDark: '#3b0f3f',
  plush: '#7c1f7a',
  plushLit: '#e05fd0',
  // Lamp glow and bare-concrete vacancy.
  warm: '#ffcc66',
  dust: '#5c5570',
  dustDark: '#403a52',
  ledGreen: '#39ff88',
};
