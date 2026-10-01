import { tourSnippet, type TourSnippet, type TourStep } from '@agenthub/shared/tour';
import { getJson } from '../api.js';
import type { EditorHandle } from '../code/editor.js';
import type { CodeFileDoc } from '../code/model.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import { renderDocMarkdown } from '../markdown.js';
import { note } from './parts.js';

/**
 * The tour (FR-B6): the code map's links one at a time — the snippet on the left, read-only with
 * its lines tinted, and the guide's explanation of it on the right.
 *
 * The snippet is drawn from the file straight away, with the same `tourSnippet` the hub explains
 * (so the two always agree); the explanation arrives when the hub has it, which is instantly for a
 * step somebody has read before and a model run for one nobody has (decision 0057). Moving on
 * abandons the request, and the hub stops the run behind it.
 */

/** What `GET /api/projects/:slug/tour/:index` returns. */
interface TourStepDoc {
  index: number;
  total: number;
  step: TourStep;
  snippet: TourSnippet;
  explanation: string;
  cached: boolean;
}

export interface TourDeps {
  slug: string;
  /** The steps as the map now stands; read on every move, so a refreshed map is picked up. */
  steps(): TourStep[];
  /** Open this file at this line in the Files tab, where it can be edited. */
  openInEditor(path: string, line: number): void;
  /** Open the guide with a question about this step started. */
  askAbout(step: TourStep, snippet: TourSnippet | null, index: number): void;
}

export interface TourHandle {
  root: HTMLElement;
  /** Shows step `index` (0-based); clamped to the tour. */
  show(index: number): void;
  /** The step on screen, or null before the tour was started. */
  current(): number | null;
  destroy(): void;
}

const EDITOR_MISSING = 'The editor could not be loaded. Reload the page and try again.';

export function mountTour(deps: TourDeps): TourHandle {
  let alive = true;
  let index: number | null = null;
  let snippet: TourSnippet | null = null;
  let token = 0;
  let inflight: AbortController | null = null;

  const root = el('section', 'tour');

  const count = el('span', 'tour__count');
  const title = el('h2', 'tour__title');
  const where = el('span', 'tour__path');
  const heading = el('div', 'tour__heading');
  heading.append(count, title, where);

  const openButton = button('Open in editor', 'btn btn--plain btn--small');
  const askButton = button('', 'btn btn--plain btn--small');
  askButton.append(icon('chat', 15), document.createTextNode('Ask about this'));
  const backButton = button('', 'btn btn--small');
  backButton.append(icon('chevronLeft', 14), document.createTextNode('Back'));
  const nextButton = button('', 'btn btn--primary btn--small');
  nextButton.append(document.createTextNode('Next'), icon('chevronRight', 14));
  const nav = el('div', 'actions tour__nav');
  nav.append(openButton, askButton, backButton, nextButton);

  const head = el('header', 'tour__head');
  head.append(heading, nav);

  const codeNote = el('div', 'code__note');
  const editorBox = el('div', 'code__editor');
  const code = el('div', 'tour__code');
  code.append(codeNote, editorBox);
  const text = el('article', 'md tour__text');
  text.setAttribute('aria-live', 'polite');
  const panes = el('div', 'tour__panes');
  panes.append(code, text);

  const empty = el('div', 'tour__empty');
  root.append(head, panes, empty);

  /** Loaded with the first step, not with the screen: a reader who never tours never pays for it. */
  let editorReady: Promise<EditorHandle | null> | null = null;
  let editor: EditorHandle | null = null;
  const loadEditor = (): Promise<EditorHandle | null> => {
    editorReady ??= import('../code/editor.js')
      .then((module) => {
        if (!alive) return null;
        editor = module.mountEditor(editorBox, { onChange: () => {}, onSave: () => {} });
        return editor;
      })
      .catch(() => null);
    return editorReady;
  };

  const codeMessage = (message: string, kind: 'empty' | 'error' = 'empty'): void => {
    editorBox.hidden = true;
    codeNote.hidden = false;
    codeNote.replaceChildren(note(message, kind));
  };

  const textMessage = (message: string, retry?: () => void): void => {
    text.replaceChildren(note(message, retry ? 'error' : 'empty'));
    if (retry) {
      const again = button('Retry', 'btn btn--small');
      again.addEventListener('click', retry);
      text.appendChild(again);
    }
  };

  const loadCode = (step: TourStep, mine: number, signal: AbortSignal): void => {
    codeMessage(`Opening ${step.path}…`);
    void Promise.all([
      getJson<CodeFileDoc>(`/api/projects/${deps.slug}/code/file?path=${encodeURIComponent(step.path)}`, signal),
      loadEditor(),
    ])
      .then(([doc, ed]) => {
        if (mine !== token || !alive) return;
        if (!ed) { codeMessage(EDITOR_MISSING, 'error'); return; }
        snippet = tourSnippet(doc.text, step.line);
        if (!snippet) {
          codeMessage(`${step.path} has no line ${step.line} any more — the map may be out of date.`, 'error');
          return;
        }
        where.textContent = `${step.path}:${snippet.from}–${snippet.to}`;
        codeNote.hidden = true;
        editorBox.hidden = false;
        ed.open(doc.path, doc.text, true);
        ed.markLines(snippet.from, snippet.to);
      })
      .catch((error: unknown) => {
        if (mine !== token || !alive || signal.aborted) return;
        codeMessage(`Could not open ${step.path}: ${String(error)}`, 'error');
      });
  };

  const loadText = (at: number, mine: number, signal: AbortSignal): void => {
    textMessage('The guide is reading this step… The first reader of a step waits for it; everyone after gets it instantly.');
    text.setAttribute('aria-busy', 'true');
    void getJson<TourStepDoc>(`/api/projects/${deps.slug}/tour/${at}`, signal)
      .then((doc) => {
        if (mine !== token || !alive) return;
        text.removeAttribute('aria-busy');
        text.innerHTML = renderDocMarkdown(doc.explanation);
      })
      .catch((error: unknown) => {
        if (mine !== token || !alive || signal.aborted) return;
        text.removeAttribute('aria-busy');
        textMessage(`Could not explain this step: ${String(error)}`, () => show(at));
      });
  };

  function show(at: number): void {
    const steps = deps.steps();
    inflight?.abort();
    const mine = ++token;
    snippet = null;
    const empty_ = !steps.length;
    head.hidden = empty_;
    panes.hidden = empty_;
    empty.hidden = !empty_;
    if (empty_) {
      index = null;
      empty.replaceChildren(note('The map links to no lines yet, so there is nothing to step through. Refresh the map, then come back.'));
      return;
    }
    index = Math.min(Math.max(0, at), steps.length - 1);
    const step = steps[index];
    count.textContent = `Step ${index + 1} of ${steps.length}`;
    title.textContent = step.title;
    where.textContent = `${step.path}:${step.line}`;
    backButton.disabled = index === 0;
    nextButton.disabled = index === steps.length - 1;

    const ac = new AbortController();
    inflight = ac;
    loadCode(step, mine, ac.signal);
    loadText(index, mine, ac.signal);
  }

  backButton.addEventListener('click', () => { if (index !== null) show(index - 1); });
  nextButton.addEventListener('click', () => { if (index !== null) show(index + 1); });
  openButton.addEventListener('click', () => {
    if (index === null) return;
    const step = deps.steps()[index];
    if (step) deps.openInEditor(step.path, snippet?.from ?? step.line);
  });
  askButton.addEventListener('click', () => {
    if (index === null) return;
    const step = deps.steps()[index];
    if (step) deps.askAbout(step, snippet, index);
  });
  // The explanation cites lines as `path:line`; those open in the editor like the map's do.
  text.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]');
    if (!link?.dataset.path) return;
    event.preventDefault();
    deps.openInEditor(link.dataset.path, Number(link.dataset.line ?? 1));
  });

  return {
    root,
    show,
    current: () => index,
    destroy: () => {
      alive = false;
      inflight?.abort();
      editor?.destroy();
    },
  };
}
