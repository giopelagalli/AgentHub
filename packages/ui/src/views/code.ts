import { tourSteps, type TourSnippet, type TourStep } from '@agenthub/shared/tour';
import { getJson, sendJson } from '../api.js';
import type { EditorHandle } from '../code/editor.js';
import { ancestors, formatSize, step, visibleRows, type CodeEntry, type CodeFileDoc, type CodeTreeDoc } from '../code/model.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import { renderMarkdown } from '../markdown.js';
import { toast } from '../toast.js';
import { note, type ViewContext } from './parts.js';
import { mountTour } from './tour.js';

/**
 * The Code screen (FR-B3–B5): the workspace's file tree, the file open in an editor, and — in the
 * sheet's own right-hand slot — the guide, which is the same chat drawer every other view docks.
 *
 * Three tabs. *Files* is the tree; *Map* is `docs/code-map.md`, the page the manager writes at
 * milestone completion, whose `path:line` links open a file here at that line; *Tour* (FR-B6, in
 * `tour.ts`) steps through those same links with the guide's explanation of each. *Start tour* on
 * the Map is the way in the PRD names; the tab is how a reader gets back to where they were.
 *
 * Unlike the document views this one does not redraw itself wholesale: the editor holds the owner's
 * unsaved text and its own undo history, so the frame is built once and the parts that move — the
 * tree rows, the file header, the map — are replaced in place.
 */

/** The docs page the map lives on; the hub writes it with `write_code_map`. */
const MAP_PAGE = 'code-map';

/** Shown where the editor would be when its chunk did not load — a file cannot be opened at all. */
const EDITOR_MISSING = 'The editor could not be loaded. Reload the page and try again.';

/** What a save comes back with: `committed: 'none'` is a file the hub deliberately did not commit. */
interface SaveResult {
  path: string;
  committed: 'workspace' | 'bundle' | 'none';
}

type Pane = 'files' | 'map' | 'tour';
type Fetch = 'loading' | 'ready' | 'failed';

export function mountCode(host: HTMLElement, ctx: ViewContext): () => void {
  let alive = true;
  let pane: Pane = 'files';

  let treeState: Fetch = 'loading';
  let tree: CodeTreeDoc | null = null;
  let treeError = '';
  const expanded = new Set<string>();
  let selected: string | null = null;

  /** The file in the editor: null before one is opened, and while one is being fetched. */
  let open: CodeFileDoc | null = null;
  /** What the middle column says instead of an editor while `open` is null. */
  let fileMessage = 'Pick a file on the left, or follow a link from the map.';
  let dirty = false;
  let saving = false;
  let fileToken = 0;

  let mapState: Fetch | 'missing' = 'loading';
  let mapMarkdown = '';
  let refreshing = false;

  // --- the frame, built once -----------------------------------------------------

  const root = el('div', 'code');

  const tabs = el('div', 'code__tabs');
  const filesTab = button('Files', 'code__tab');
  const mapTab = button('Map', 'code__tab');
  const tourTab = button('Tour', 'code__tab');
  tabs.append(filesTab, mapTab, tourTab);

  const actions = el('div', 'actions');
  const refreshButton = button('Refresh map', 'btn btn--small');
  const tourButton = button('Start tour', 'btn btn--primary btn--small');
  const guideButton = button('', 'btn btn--plain btn--small');
  guideButton.append(icon('chat', 15), document.createTextNode('Ask the guide'));
  guideButton.title = 'Ask the guide about this code — its answers link to the lines they mean';
  actions.append(refreshButton, tourButton, guideButton);

  const bar = el('div', 'code__bar');
  bar.append(tabs, actions);

  const treeBox = el('nav', 'code__tree');
  treeBox.setAttribute('aria-label', 'Workspace files');

  const path = el('span', 'code__path', 'No file open');
  const dirtyMark = el('span', 'code__dirty', '●');
  dirtyMark.title = 'Unsaved changes';
  dirtyMark.hidden = true;
  const saveButton = button('Save', 'btn btn--primary');
  saveButton.disabled = true;
  const head = el('header', 'code__head');
  head.append(path, dirtyMark, saveButton);

  const editorBox = el('div', 'code__editor');
  const fileNote = el('div', 'code__note');
  const view = el('section', 'code__view');
  view.append(head, fileNote, editorBox);

  const panes = el('div', 'code__panes');
  panes.append(treeBox, view);

  const mapBox = el('article', 'md code__map');

  const steps = (): TourStep[] => (mapState === 'ready' ? tourSteps(mapMarkdown) : []);
  const tour = mountTour({
    slug: ctx.slug,
    steps,
    openInEditor: (target, line) => reveal(target, line),
    askAbout: (step, snippet, index) => openGuide(askDraft(step, snippet, index)),
  });

  // The page's bar under the toolbar takes this view's bar when it offers one.
  if (ctx.actions) {
    ctx.actions.replaceChildren(bar);
    root.append(panes, mapBox, tour.root);
  } else root.append(bar, panes, mapBox, tour.root);
  host.replaceChildren(root);

  /**
   * CodeMirror is loaded when this screen is opened, not when the app is. It is by far the heaviest
   * thing the UI depends on (see decision 0043), and every other page would otherwise pay for it on
   * first paint. Nothing but this view imports it, so the bundler gives it a chunk of its own.
   */
  let editor: EditorHandle | null = null;
  const editorReady = import('../code/editor.js').then((module) => {
    if (!alive) return null;
    editor = module.mountEditor(editorBox, {
      onChange: () => { if (!dirty) { dirty = true; renderHead(); } },
      onSave: () => save(),
    });
    return editor;
  }).catch(() => {
    if (alive) openNothing(EDITOR_MISSING);
    return null;
  });

  // --- drawing -------------------------------------------------------------------

  const renderTabs = (): void => {
    filesTab.setAttribute('aria-current', String(pane === 'files'));
    mapTab.setAttribute('aria-current', String(pane === 'map'));
    tourTab.setAttribute('aria-current', String(pane === 'tour'));
    panes.hidden = pane !== 'files';
    mapBox.hidden = pane !== 'map';
    tour.root.hidden = pane !== 'tour';
    refreshButton.hidden = pane !== 'map';
    tourButton.hidden = pane !== 'map' || !steps().length;
  };

  /** The tour from its first step, or from where the reader left it when they come back by the tab. */
  const startTour = (from?: number): void => {
    pane = 'tour';
    renderTabs();
    tour.show(from ?? tour.current() ?? 0);
  };

  const renderHead = (): void => {
    path.textContent = open ? open.path : 'No file open';
    dirtyMark.hidden = !dirty;
    saveButton.disabled = !open || !dirty || saving;
    saveButton.textContent = saving ? 'Saving…' : 'Save';
    editorBox.hidden = !open;
    fileNote.hidden = !!open;
    fileNote.textContent = open ? '' : fileMessage;
  };

  const rowNode = (entry: CodeEntry, depth: number, name: string): HTMLElement => {
    const row = button('', entry.dir ? 'code__row code__row--dir' : 'code__row');
    row.dataset.path = entry.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    if (entry.path === selected) row.setAttribute('aria-current', 'true');
    // A folder carries a disclosure chevron and a folder; a file a page, set in a line with them.
    const twist = el('span', 'code__twist');
    if (entry.dir) twist.appendChild(icon(expanded.has(entry.path) ? 'chevronDown' : 'chevronRight', 12));
    if (entry.dir) row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
    row.append(twist, icon(entry.dir ? 'folder' : 'doc', 15), el('span', 'code__name', name));
    if (!entry.dir) row.append(el('span', 'code__size', entry.openable ? formatSize(entry.size) : 'not text'));
    row.addEventListener('click', () => activate(entry));
    return row;
  };

  const renderTree = (): void => {
    treeBox.replaceChildren();
    if (treeState === 'loading') { treeBox.appendChild(note('Reading the workspace…')); return; }
    if (treeState === 'failed') { treeBox.appendChild(note(treeError, 'error')); return; }
    const rows = visibleRows(tree?.entries ?? [], expanded);
    if (!rows.length) { treeBox.appendChild(note('The workspace is empty.')); return; }
    for (const row of rows) treeBox.appendChild(rowNode(row.entry, row.depth, row.name));
    if (tree?.truncated) treeBox.appendChild(note('Too many files to list them all.'));
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

  /** The map changed: redraw it, and the Start tour button that depends on it having links. */
  const mapChanged = (): void => {
    renderMap();
    renderTabs();
  };

  // --- what the owner does -------------------------------------------------------

  /** Refuses to leave a file with unsaved edits without being told to. */
  const mayLeave = (): boolean =>
    !dirty || !open || window.confirm(`Discard your unsaved changes to ${open.path}?`);

  const activate = (entry: CodeEntry): void => {
    if (entry.dir) {
      if (expanded.has(entry.path)) expanded.delete(entry.path); else expanded.add(entry.path);
      selected = entry.path;
      renderTree();
      return;
    }
    if (!entry.openable) {
      selected = entry.path;
      openNothing(`${entry.path} is not text the viewer can open.`);
      renderTree();
      return;
    }
    openFile(entry.path);
  };

  const openNothing = (message: string): void => {
    open = null;
    dirty = false;
    fileMessage = message;
    renderHead();
  };

  function openFile(target: string, line?: number): void {
    if (!mayLeave()) return;
    const mine = ++fileToken;
    selected = target;
    openNothing(`Opening ${target}…`);
    renderTree();
    void Promise.all([
      getJson<CodeFileDoc>(`/api/projects/${ctx.slug}/code/file?path=${encodeURIComponent(target)}`),
      editorReady,
    ])
      .then(([doc, ed]) => {
        if (mine !== fileToken || !alive) return;
        // The chunk never arrived: say so, rather than leaving "Opening…" on screen forever.
        if (!ed) { openNothing(EDITOR_MISSING); return; }
        open = doc;
        dirty = false;
        // The editor is measured as it is filled, so the column it lives in is shown first.
        renderHead();
        ed.open(doc.path, doc.text, false);
        if (line) ed.goToLine(line);
      })
      .catch((error: unknown) => {
        if (mine !== fileToken || !alive) return;
        openNothing(`Could not open ${target}: ${String(error)}`);
      });
  }

  function save(): void {
    if (!open || saving || !dirty || !editor) return;
    const target = open.path;
    const text = editor.text();
    saving = true;
    renderHead();
    void sendJson<SaveResult>(`/api/projects/${ctx.slug}/code/file`, { path: target, text }, 'PUT')
      .then((result) => {
        if (!alive) return;
        // Only this file's own edits are clean now: the owner may have moved on while it saved.
        if (open && open.path === target) { dirty = false; open = { ...open, text }; }
        // A file the hub holds out of version control — a `.env`, or one the repository ignores —
        // is saved and says so, because "saved" alone would imply the next turn will see it.
        toast(result?.committed === 'none'
          ? `Saved ${target} — not committed: it is excluded from version control.`
          : `Saved ${target}`);
      })
      .catch((error: unknown) => { if (alive) toast(`Could not save ${target}: ${String(error)}`, 'error'); })
      .finally(() => { if (alive) { saving = false; renderHead(); } });
  }

  /** A `path:line` link from the map: expand the tree down to the file and open it at the line. */
  const reveal = (target: string, line: number): void => {
    for (const dir of ancestors(target)) expanded.add(dir);
    pane = 'files';
    renderTabs();
    openFile(target, line);
  };

  const loadTree = (): void => {
    treeState = tree ? treeState : 'loading';
    void getJson<CodeTreeDoc>(`/api/projects/${ctx.slug}/code/tree`)
      .then((doc) => {
        if (!alive) return;
        tree = doc;
        treeState = 'ready';
        renderTree();
      })
      .catch((error: unknown) => {
        if (!alive) return;
        treeState = 'failed';
        treeError = `Could not read the workspace: ${String(error)}`;
        renderTree();
      });
  };

  const loadMap = (): void => {
    void getJson<{ markdown: string }>(`/api/projects/${ctx.slug}/docs/${MAP_PAGE}`)
      .then((doc) => {
        if (!alive) return;
        mapMarkdown = doc.markdown ?? '';
        mapState = 'ready';
        mapChanged();
      })
      .catch(() => {
        if (!alive) return;
        // There is no map page until something writes one, and that 404 is the ordinary case.
        mapState = 'missing';
        mapChanged();
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

  /** What *Ask about this* starts the guide's message box with: the lines, and room for the question. */
  const askDraft = (step: TourStep, snippet: TourSnippet | null, index: number): string =>
    `About \`${step.path}:${snippet?.from ?? step.line}\`${snippet ? `–${snippet.to}` : ''} (tour step ${index + 1}): `;

  const openGuide = (draft?: string): void => {
    ctx.openChat({
      name: 'Guide',
      subtitle: `${ctx.title} · the code`,
      endpoint: `/api/projects/${ctx.slug}/chat/guide/messages`,
      historyEndpoint: `/api/projects/${ctx.slug}/chat/guide`,
      // The guide is told to cite files as `path:line`; this is what makes those citations open.
      onCodeRef: (target, line) => reveal(target, line),
      ...(draft ? { draft } : {}),
    });
  };

  // --- wiring --------------------------------------------------------------------

  filesTab.addEventListener('click', () => { pane = 'files'; renderTabs(); });
  mapTab.addEventListener('click', () => { pane = 'map'; renderTabs(); });
  tourTab.addEventListener('click', () => startTour());
  tourButton.addEventListener('click', () => startTour(0));
  refreshButton.addEventListener('click', refreshMap);
  guideButton.addEventListener('click', () => openGuide());
  saveButton.addEventListener('click', save);

  // Up and down walk the rows on screen and take focus with them, which is what makes Enter work:
  // the selected row is a real button, so the browser's own Enter-activates-a-button does the rest.
  treeBox.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    selected = step(visibleRows(tree?.entries ?? [], expanded), selected, event.key === 'ArrowDown' ? 1 : -1);
    renderTree();
    treeBox.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  });

  mapBox.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]');
    if (!link?.dataset.path) return;
    event.preventDefault();
    reveal(link.dataset.path, Number(link.dataset.line ?? 1));
  });

  // Cmd/Ctrl-S anywhere in the screen, not only inside the editor.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
    if (!root.isConnected) return;
    event.preventDefault();
    save();
  };
  window.addEventListener('keydown', onKey);

  renderTabs();
  renderHead();
  renderTree();
  renderMap();
  loadTree();
  loadMap();
  // Beside the files where there is room for both; on a narrow window the pane would cover them,
  // so there it waits to be asked for.
  if (window.matchMedia?.('(min-width: 1001px)').matches ?? true) openGuide();

  return () => {
    alive = false;
    fileToken++;
    window.removeEventListener('keydown', onKey);
    editor?.destroy();
    tour.destroy();
    host.replaceChildren();
  };
}
