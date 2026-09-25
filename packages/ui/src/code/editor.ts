import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view';

/**
 * The Code screen's editor: CodeMirror 6, assembled by hand rather than through `basic-setup`.
 *
 * Only what the screen actually needs is loaded — a gutter, history, a dark theme and one language
 * per file type — because every extension is bundle weight the whole app pays for. Autocompletion,
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
  destroy(): void;
}

export interface EditorOptions {
  /** The document changed: the caller lights its dirty indicator. */
  onChange(): void;
  /** Cmd/Ctrl-S inside the editor. */
  onSave(): void;
}

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const language = new Compartment();
  const editable = new Compartment();

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
    oneDark,
    language.of([]),
    editable.of([]),
    EditorView.updateListener.of((update) => { if (update.docChanged) opts.onChange(); }),
  ];

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions: extensions() }) });

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
    destroy: () => view.destroy(),
  };
}
