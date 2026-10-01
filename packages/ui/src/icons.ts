/**
 * The app's icons: a small inline SVG set drawn on one 24-unit grid, stroked rather than filled,
 * so every glyph takes the colour of the text around it (`currentColor`) and reads the same in the
 * light and the dark theme. No icon font and no package — each one is a few path commands.
 *
 * The stroke is 1.75 units on the 24 grid, which lands at ~1.5px at the 20px toolbar size and a
 * little finer at the 16px inline size: the hairline weight the rest of the interface uses.
 *
 * The markup below is constant and never carries data, which is the only reason `innerHTML` is
 * acceptable here.
 */

const PATHS = {
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.25 4.5v15"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  search: '<circle cx="10.75" cy="10.75" r="6"/><path d="m15.25 15.25 4.25 4.25"/>',
  chat: '<path d="M7.5 4.75h9a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H12l-4.25 3.25V16.75H7.5a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/>',
  more: '<circle cx="6" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.6v12.8a.8.8 0 0 0 1.2.68l10.2-6.4a.8.8 0 0 0 0-1.36L9.2 4.92A.8.8 0 0 0 8 5.6z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  gear: '<path d="M18.75 10.13L21.36 10.39L21.36 13.61L18.75 13.87A7 7 0 0 1 18.09 15.45L19.76 17.48L17.48 19.76L15.45 18.09A7 7 0 0 1 13.87 18.75L13.61 21.36L10.39 21.36L10.13 18.75A7 7 0 0 1 8.55 18.09L6.52 19.76L4.24 17.48L5.91 15.45A7 7 0 0 1 5.25 13.87L2.64 13.61L2.64 10.39L5.25 10.13A7 7 0 0 1 5.91 8.55L4.24 6.52L6.52 4.24L8.55 5.91A7 7 0 0 1 10.13 5.25L10.39 2.64L13.61 2.64L13.87 5.25A7 7 0 0 1 15.45 5.91L17.48 4.24L19.76 6.52L18.09 8.55A7 7 0 0 1 18.75 10.13Z"/><circle cx="12" cy="12" r="3"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevronRight: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  chevronLeft: '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  check: '<path d="m5.5 12.5 4.25 4.25L18.5 7.5"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  machines: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  help: '<circle cx="12" cy="12" r="8.75"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.85c0 1.75-2.45 2.2-2.45 3.75M12 17.1h.01"/>',
  folder: '<path d="M3.75 7.5a2 2 0 0 1 2-2h3.6l2.1 2.25h7.05a2 2 0 0 1 2 2v7.75a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M14 3.75H7.5a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.25z"/><path d="M14 3.75v4.5h4.5M9 12.5h6M9 16h4"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  globe: '<circle cx="12" cy="12" r="8.75"/><path d="M3.25 12h17.5M12 3.25c2.4 2.5 3.6 5.4 3.6 8.75S14.4 18.25 12 20.75C9.6 18.25 8.4 15.35 8.4 12S9.6 5.75 12 3.25z"/>',
  arrowUp: '<path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/>',
  arrowDown: '<path d="M12 5.5v13M6.5 13l5.5 5.5 5.5-5.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.25h5V7M6.75 7l.85 11.35a2 2 0 0 0 2 1.9h4.8a2 2 0 0 0 2-1.9L17.25 7"/>',
  refresh: '<path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13M19.25 4.75v4.5h-4.5"/>',
  copy: '<rect x="8.75" y="8.75" width="11" height="11" rx="2.25"/><path d="M15.25 8.75v-2a2 2 0 0 0-2-2h-6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M13.5 4.75h5.75v5.75M19.25 4.75 11 13M17 14.25V18a2 2 0 0 1-2 2H6.25a2 2 0 0 1-2-2V9.25a2 2 0 0 1 2-2H10"/>',
  personAdd: '<circle cx="10" cy="8.5" r="3.5"/><path d="M3.75 19.25c.75-3.1 3.2-4.75 6.25-4.75s5.5 1.65 6.25 4.75M18.5 8v6M15.5 11h6"/>',
  sparkle: '<path d="M12 3.75l1.75 5 5 1.75-5 1.75-1.75 5-1.75-5-5-1.75 5-1.75zM18.5 16.25l.6 1.65 1.65.6-1.65.6-.6 1.65-.6-1.65-1.65-.6 1.65-.6z"/>',
  branch: '<circle cx="7" cy="5.75" r="2"/><circle cx="7" cy="18.25" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 7.75v8.5M17 10c0 3.75-4.5 3.5-8.6 6.9"/>',
  key: '<circle cx="8" cy="15.5" r="3.75"/><path d="m10.75 12.75 8-8M15.75 7.75l2.5 2.5M13.5 10l2 2"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M3 9h18M6.5 6.75h.01M9 6.75h.01"/>',
  queue: '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75v2.75"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17.5 5-4.5 4 3.5 2.5-2 4.5 3.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One icon as an `<svg>`, `size` pixels square, decorative unless the caller labels its button. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  svg.innerHTML = PATHS[name];
  return svg;
}

/** Every icon name, for anything that wants to draw the whole set. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];
