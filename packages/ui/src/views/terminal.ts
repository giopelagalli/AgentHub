import { el } from '../dom.js';
import { note, type ViewContext } from './parts.js';

/**
 * FR-B2 — the Terminal sheet: xterm.js on one end, a pty in the project's `workspace/` on the
 * other, over the hub's own WebSocket under the owner's session.
 *
 * This is the owner's own shell on the machine the hub runs on, with the reach of the OS user the
 * hub runs as — the footer says so, because a web page that looks like a terminal should not be
 * able to be mistaken for a sandbox. The socket carries the pty's bytes as binary frames and
 * nothing else; the only thing this end says in text is the window size.
 *
 * One socket is one shell: the hub kills the process group when the socket closes, so a reconnect
 * is a *new* shell, which the banner and the divider line both say rather than leaving the reader
 * to wonder where their `cd` went.
 */

/** Shown in the sheet when xterm's chunk did not load — there is no shell to open without it. */
export const TERMINAL_MISSING = 'The terminal could not be loaded. Reload the page and try again.';

/** Shown when the chunk loaded but the terminal could not start. */
const TERMINAL_FAILED = 'The terminal could not be started. Reload the page and try again.';

/** The project's terminal socket, from the page's own origin so the session cookie goes with it. */
export function terminalUrl(loc: { protocol: string; host: string }, slug: string): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/api/projects/${encodeURIComponent(slug)}/terminal`;
}

/** The one control frame this end sends: the window size, as text, where output is binary. */
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols: Math.max(1, Math.round(cols)), rows: Math.max(1, Math.round(rows)) });
}

/** Keystrokes go up as binary, so a byte the shell cares about is never re-encoded on the way. */
export function encodeInput(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export interface Notice { type: 'error' | 'closed'; message: string }

/** A text frame from the hub: why it is refusing, or why it closed. Anything else is ignored. */
export function parseNotice(text: string): Notice | null {
  let msg: { type?: unknown; message?: unknown; reason?: unknown };
  try {
    msg = JSON.parse(text) as { type?: unknown; message?: unknown; reason?: unknown };
  } catch {
    return null;
  }
  if (msg.type !== 'error' && msg.type !== 'closed') return null;
  const body = typeof msg.message === 'string' ? msg.message : typeof msg.reason === 'string' ? msg.reason : '';
  return { type: msg.type, message: body };
}

/** Backoff between reconnects: 1s, 2s, 4s, 8s, then every 8s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt));
}

/** After this many failed attempts the banner stops promising and hands the reader the button. */
export const MAX_RECONNECTS = 5;

/**
 * Whether a socket that just closed should be dialled again, given the last notice the hub sent on
 * it. Only an *unexplained* drop reconnects. A notice means the hub ended this session on purpose —
 * the idle timeout, a shell that exited, the session cap, an unknown project — and every one of
 * those would be undone by a fresh pty: the idle timeout would be a no-op, and a shell that exits
 * the moment it starts would become a spawn loop. **New session** is the deliberate restart.
 */
export function reconnectAfter(notice: Notice | null, attempts: number): boolean {
  return notice === null && attempts < MAX_RECONNECTS;
}

/**
 * xterm is loaded when the Terminal is opened, not when the app is: it is a third of the bundle
 * and most sessions never press the button. Only `terminal-mount.ts` imports it, so the bundler
 * gives it a chunk of its own, and its CSS with it. The dispose returned here is safe to call
 * before the chunk has arrived — it just stops the mount from happening — the same shape the Code
 * view uses for its editor.
 */
export function mountTerminal(host: HTMLElement, ctx: ViewContext): () => void {
  let alive = true;
  let dispose: (() => void) | null = null;
  const loading = el('div', 'term');
  loading.appendChild(note('Loading the terminal…'));
  host.appendChild(loading);

  /** A mount that throws leaves no half-built `.term` root: the loading box goes back, saying so. */
  const onLoaded = (module: typeof import('./terminal-mount.js')): void => {
    if (!alive) return;
    loading.remove();
    try {
      dispose = module.mountTerminalScreen(host, ctx);
    } catch {
      host.replaceChildren(loading);
      loading.replaceChildren(note(TERMINAL_FAILED, 'error'));
    }
  };
  const onFailed = (): void => {
    if (!alive) return;
    loading.replaceChildren(note(TERMINAL_MISSING, 'error'));
  };
  void import('./terminal-mount.js').then(onLoaded, onFailed);

  return () => {
    alive = false;
    dispose?.();
    dispose = null;
    loading.remove();
  };
}
