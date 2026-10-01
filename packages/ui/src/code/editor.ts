import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view';

/**
 * The Code screen's editor: CodeMirror 6, assembled by hand rather than through `basic-setup`.
 *
 * Only what the screen actually needs is loaded — a gutter, history, a theme and one language per
 * file type — because every extension is bundle weight the whole app pays for. Autocompletion,
 * linting, search and folding are deliberately absent: this is where the owner reads their agents'
 * code and fixes a line, not an IDE.
 */

/** The languages the viewer highlights, by extension. Anything else is plain text, still readable. */
const LANGUAGES: Record<string, () => Extension> = {
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
};

/** The language extension for `path`, or nothing at all when we don't know the file type. */
export function languageFor(path: string): Extension {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const extension = dot > slash ? path.slice(dot + 1).toLowerCase() : '';
  return LANGUAGES[extension]?.() ?? [];
}

export interface EditorHandle {
  /** Puts a file in the editor, with the language its extension picks; resets the undo history. */
  open(path: string, text: string, readOnly: boolean): void;
  /** What is in the editor now — what Save sends. */
  text(): string;
  /** Scrolls a 1-based line into the middle and puts the cursor on it. */
  goToLine(line: number): void;
  /**
   * Tints lines `from`–`to` (1-based, inclusive) and scrolls them to the top, without taking focus —
   * the tour's "these are the lines". Opening another file clears it.
   */
  markLines(from: number, to: number): void;
  destroy(): void;
}

export interface EditorOptions {
  /** The document changed: the caller lights its dirty indicator. */
  onChange(): void;
  /** Cmd/Ctrl-S inside the editor. */
  onSave(): void;
}

/**
 * The editor's chrome is the app's own tokens, so it is light in the light theme and dark in the
 * dark one without a second stylesheet; only the syntax colours have to be swapped by hand.
 */
const chrome = EditorView.theme({
  '&': { height: '100%', color: 'var(--label)', backgroundColor: 'var(--bg)', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { color: 'var(--label-4)', backgroundColor: 'var(--bg)', border: 'none' },
  '.cm-activeLineGutter': { color: 'var(--label-2)', backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-marked': { backgroundColor: 'var(--accent-soft)' },
});

const MARKED_LINE = Decoration.line({ class: 'cm-marked' });

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** Whether the page is dark right now: a pinned `data-theme` wins over the system. */
function isDark(): boolean {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === 'dark' || pinned === 'light') return pinned === 'dark';
  return darkQuery?.matches ?? false;
}

const palette = (): Extension => syntaxHighlighting(isDark() ? oneDarkHighlightStyle : defaultHighlightStyle);

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const language = new Compartment();
  const editable = new Compartment();
  const highlight = new Compartment();
  const marked = new Compartment();

  const extensions = (): Extension[] => [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    indentUnit.of('  '),
    EditorView.lineWrapping,
    // Save first, so a file's own keymap can never swallow Cmd-S.
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true; } }]),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    chrome,
    highlight.of(palette()),
    language.of([]),
    editable.of([]),
    marked.of([]),
    EditorView.updateListener.of((update) => { if (update.docChanged) opts.onChange(); }),
  ];

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions: extensions() }) });

  // The system switching between light and dark while a file is open re-colours it in place.
  const onScheme = (): void => { view.dispatch({ effects: highlight.reconfigure(palette()) }); };
  darkQuery?.addEventListener('change', onScheme);

  return {
    open: (path, text, readOnly) => {
      // A fresh state rather than a transaction: the previous file's undo history must not be
      // reachable from this one, or Cmd-Z would type the old file into the new one.
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      view.dispatch({
        effects: [
          language.reconfigure(languageFor(path)),
          editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        ],
      });
    },
    text: () => view.state.doc.toString(),
    goToLine: (line) => {
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      });
      view.focus();
    },
    markLines: (from, to) => {
      const doc = view.state.doc;
      const first = Math.min(Math.max(1, from), doc.lines);
      const last = Math.min(Math.max(first, to), doc.lines);
      const lines = new RangeSetBuilder<Decoration>();
      for (let n = first; n <= last; n++) lines.add(doc.line(n).from, doc.line(n).from, MARKED_LINE);
      view.dispatch({
        effects: [
          marked.reconfigure(EditorView.decorations.of(lines.finish())),
          EditorView.scrollIntoView(doc.line(first).from, { y: 'start', yMargin: 48 }),
        ],
      });
    },
    destroy: () => {
      darkQuery?.removeEventListener('change', onScheme);
      view.destroy();
    },
  };
}
