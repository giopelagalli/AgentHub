import { tourSteps, type TourSnippet, type TourStep } from '@agenthub/shared/tour';
import { getJson, sendJson } from '../api.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import { renderMarkdown } from '../markdown.js';
import { toast } from '../toast.js';
import { note, type ViewContext } from './parts.js';
import { mountTour } from './tour.js';

/**
 * Docs → *How the code works* (decision 0072): the code map, then its tour — the two things for
 * *understanding* the code, moved off the Code tab so that tab is only the code itself.
 *
 * The map is `docs/code-map.md`, the page the manager writes at milestone completion; its
 * `path:line` links open the file in Code → Files at that line. *Start tour* (FR-B6, `tour.ts`)
 * steps through those same links with the Guide's explanation of each, in place of the map; *Back
 * to the map* returns, and the button then reads *Resume tour* and picks up at the same step.
 *
 * A step's links lead out of here (to Code → Files), which takes this view down. Where the reader
 * was is kept in a `TourPlace` the page owns, one per project: coming back finds the tour at the
 * step they left, or the map with *Resume tour* if that is where they were.
 */

/** The docs page the map lives on; the hub writes it with `write_code_map`. */
const MAP_PAGE = 'code-map';

type Fetch = 'loading' | 'ready' | 'failed' | 'missing';

/** Where a reader was in the tour, kept by the page across this view's mounts. */
export interface TourPlace {
  /** The step to come back to (0-based); null before the tour was started. */
  step: number | null;
  /** Whether the tour, rather than the map, was on screen. */
  touring: boolean;
}

export function mountCodeMap(host: HTMLElement, ctx: ViewContext, place: TourPlace = { step: null, touring: false }): () => void {
  let alive = true;
  let touring = place.touring;
  /** The step *Resume tour* goes back to; the tour's own index while the tour is on screen. */
  let resumeAt = place.step;
  let mapState: Fetch = 'loading';
  let mapMarkdown = '';
  let refreshing = false;

  const root = el('div', 'code codemap');
  const mapBox = el('article', 'md code__map');

  const steps = (): TourStep[] => (mapState === 'ready' ? tourSteps(mapMarkdown) : []);
  const tour = mountTour({
    slug: ctx.slug,
    steps,
    openInEditor: (target, line) => ctx.openCode(target, line),
    askAbout: (step, snippet, index) => ctx.openGuide(askDraft(step, snippet, index)),
  });
  root.append(mapBox, tour.root);

  const refreshButton = button('Refresh map', 'btn btn--small');
  const tourButton = button('Start tour', 'btn btn--primary btn--small');
  const mapButton = button('', 'btn btn--small');
  mapButton.append(icon('chevronLeft', 14), document.createTextNode('Back to the map'));
  const actions = el('div', 'actions');
  actions.append(mapButton, refreshButton, tourButton);
  // The page's bar under the toolbar takes these when it offers one; else they head the view.
  if (ctx.actions) ctx.actions.replaceChildren(actions);
  else root.prepend(actions);
  host.replaceChildren(root);

  // --- drawing -------------------------------------------------------------------

  const render = (): void => {
    // A tour being come back to waits for the map it walks; until then the map says it is loading.
    const showTour = touring && mapState !== 'loading';
    mapBox.hidden = showTour;
    tour.root.hidden = !showTour;
    mapButton.hidden = !showTour;
    refreshButton.hidden = touring;
    tourButton.hidden = touring || !steps().length;
    tourButton.textContent = resumeAt !== null ? 'Resume tour' : 'Start tour';
  };

  const renderMap = (): void => {
    if (mapState === 'loading') { mapBox.replaceChildren(note('Loading the map…')); return; }
    if (mapState === 'failed') { mapBox.replaceChildren(note('Could not load the map.', 'error')); return; }
    if (mapState === 'missing' || !mapMarkdown.trim()) {
      mapBox.replaceChildren(note('No map yet. The manager writes one when a milestone lands — or press Refresh map.'));
      return;
    }
    mapBox.innerHTML = renderMarkdown(mapMarkdown);
  };

  /** The map changed: redraw it, and the tour button that depends on it having links. */
  const mapChanged = (): void => {
    renderMap();
    render();
  };

  // --- what the owner does -------------------------------------------------------

  const startTour = (): void => {
    touring = true;
    render();
    tour.show(resumeAt ?? 0);
  };

  /** The map just landed: a reader who left mid-tour is put back on their step. */
  const resume = (): void => {
    if (touring) tour.show(resumeAt ?? 0);
  };

  const loadMap = (): void => {
    void getJson<{ markdown: string }>(`/api/projects/${ctx.slug}/docs/${MAP_PAGE}`)
      .then((doc) => {
        if (!alive) return;
        mapMarkdown = doc.markdown ?? '';
        mapState = 'ready';
        mapChanged();
        resume();
      })
      .catch(() => {
        if (!alive) return;
        // There is no map page until something writes one, and that 404 is the ordinary case.
        mapState = 'missing';
        mapChanged();
        resume();
      });
  };

  const refreshMap = (): void => {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    void sendJson<{ markdown: string; written: boolean }>(`/api/projects/${ctx.slug}/code/map`)
      .then((doc) => {
        if (!alive) return;
        mapMarkdown = doc?.markdown ?? '';
        mapState = mapMarkdown.trim() ? 'ready' : 'missing';
        mapChanged();
        // `written` is the hub saying write_code_map actually ran: a run that spent its budget
        // reading and never wrote leaves the old page on screen, and saying "refreshed" would lie.
        toast(doc?.written ? 'Code map refreshed.' : 'The map was not rewritten — try again.', doc?.written ? 'info' : 'error');
      })
      .catch((error: unknown) => { if (alive) toast(`Could not refresh the map: ${String(error)}`, 'error'); })
      .finally(() => {
        if (!alive) return;
        refreshing = false;
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh map';
      });
  };

  /** What *Ask about this* starts the Guide's message box with: the lines, and room for the question. */
  const askDraft = (step: TourStep, snippet: TourSnippet | null, index: number): string =>
    `About \`${step.path}:${snippet?.from ?? step.line}\`${snippet ? `–${snippet.to}` : ''} (tour step ${index + 1}): `;

  // --- wiring --------------------------------------------------------------------

  tourButton.addEventListener('click', startTour);
  mapButton.addEventListener('click', () => {
    resumeAt = tour.current() ?? resumeAt;
    touring = false;
    render();
  });
  refreshButton.addEventListener('click', refreshMap);

  mapBox.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]');
    if (!link?.dataset.path) return;
    event.preventDefault();
    ctx.openCode(link.dataset.path, Number(link.dataset.line ?? 1));
  });

  render();
  renderMap();
  loadMap();

  return () => {
    alive = false;
    place.touring = touring;
    place.step = (touring ? tour.current() : null) ?? resumeAt;
    tour.destroy();
    host.replaceChildren();
  };
}
