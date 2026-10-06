import { getJson, sendJson } from '../api.js';
import type { EditorHandle } from '../code/editor.js';
import { ancestors, formatSize, step, visibleRows, type CodeEntry, type CodeFileDoc, type CodeTreeDoc } from '../code/model.js';
import { button, el } from '../dom.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { note, type ViewContext } from './parts.js';

/**
 * Code → Files (FR-B3–B5): the workspace's file tree and the file open in an editor — nothing
 * else (decision 0072). The map and the tour live in Docs → *How the code works*; the Guide is the
 * toolbar's chat button, which on the Code tab opens it in the page's pane.
 *
 * The editor stays quiet until it has something to say: no header and no Save until a file is
 * open, and Save only while that file has unsaved changes (⌘S works throughout).
 *
 * Unlike the document views this one does not redraw itself wholesale: the editor holds the owner's
 * unsaved text and its own undo history, so the frame is built once and the parts that move — the
 * tree rows, the file header — are replaced in place.
 */

/** Shown where the editor would be when its chunk did not load — a file cannot be opened at all. */
const EDITOR_MISSING = 'The editor could not be loaded. Reload the page and try again.';

/** The editor column's one line while no file is open. */
const NOTHING_OPEN = 'Choose a file to open it.';

/** What a save comes back with: `committed: 'none'` is a file the hub deliberately did not commit. */
interface SaveResult {
  path: string;
  committed: 'workspace' | 'bundle' | 'none';
}

type Fetch = 'loading' | 'ready' | 'failed';

export interface CodeHandle {
  /** Expands the tree down to `path` and opens it at `line` — asking first if edits would be lost. */
  reveal(path: string, line?: number): void;
  dispose(): void;
}

/** Mounts Files; `at` opens a file straight away (a map link or a citation that brought us here). */
export function mountCode(host: HTMLElement, ctx: ViewContext, at?: { path: string; line?: number }): CodeHandle {
  let alive = true;

  let treeState: Fetch = 'loading';
  let tree: CodeTreeDoc | null = null;
  let treeError = '';
  const expanded = new Set<string>();
  let selected: string | null = null;

  /** The file in the editor: null before one is opened, and while one is being fetched. */
  let open: CodeFileDoc | null = null;
  /** What the editor column says instead of an editor while `open` is null. */
  let fileMessage = NOTHING_OPEN;
  let dirty = false;
  let saving = false;
  let fileToken = 0;

  // --- the frame, built once -----------------------------------------------------

  const root = el('div', 'code');

  const treeBox = el('nav', 'code__tree');
  treeBox.setAttribute('aria-label', 'Workspace files');

  const path = el('span', 'code__path');
  const dirtyMark = el('span', 'code__dirty', '●');
  dirtyMark.title = 'Unsaved changes';
  dirtyMark.setAttribute('role', 'img');
  dirtyMark.setAttribute('aria-label', 'Unsaved changes');
  const saveButton = button('Save', 'btn btn--primary btn--small');
  saveButton.title = 'Save (⌘S)';
  const head = el('header', 'code__head');
  head.append(path, dirtyMark, saveButton);

  const editorBox = el('div', 'code__editor');
  const fileNote = el('div', 'code__note');
  const view = el('section', 'code__view');
  view.append(head, fileNote, editorBox);

  const panes = el('div', 'code__panes');
  panes.append(treeBox, view);
  root.appendChild(panes);
  // The bar under the toolbar holds only the Code tab's own control: this view adds nothing to it.
  ctx.actions?.replaceChildren();
  host.replaceChildren(root);

  /**
   * CodeMirror is loaded when this screen is opened, not when the app is. It is by far the heaviest
   * thing the UI depends on (see decision 0043), and every other page would otherwise pay for it on
   * first paint. Nothing but this view and the tour import it, so the bundler gives it a chunk of
   * its own.
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

  /** No file, no header: the column is one calm line until there is something to edit or save. */
  const renderHead = (): void => {
    head.hidden = !open;
    path.textContent = open ? open.path : '';
    dirtyMark.hidden = !dirty;
    saveButton.hidden = !open || (!dirty && !saving);
    saveButton.disabled = saving;
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

  /** A `path:line` link from the map, a tour step or the Guide: expand the tree down to it and open it. */
  const reveal = (target: string, line?: number): void => {
    for (const dir of ancestors(target)) expanded.add(dir);
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

  // --- wiring --------------------------------------------------------------------

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

  // Cmd/Ctrl-S anywhere in the screen, not only inside the editor.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
    if (!root.isConnected) return;
    event.preventDefault();
    save();
  };
  window.addEventListener('keydown', onKey);

  renderHead();
  renderTree();
  loadTree();
  if (at) reveal(at.path, at.line);

  return {
    reveal,
    dispose: () => {
      alive = false;
      fileToken++;
      window.removeEventListener('keydown', onKey);
      editor?.destroy();
      host.replaceChildren();
    },
  };
}
