import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { button, el } from '../dom.js';
import type { ViewContext } from './parts.js';

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

const FOOTER = 'shell in workspace/ on the hub host · owner only';

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

export function mountTerminal(host: HTMLElement, ctx: ViewContext): () => void {
  const root = el('div', 'term');
  const bar = el('div', 'term__bar');
  const banner = el('span', 'term__banner');
  const restart = button('New session', 'btn');
  bar.append(banner, restart);
  const screen = el('div', 'term__screen');
  const foot = el('p', 'term__foot', FOOTER);
  // The page's bar under the toolbar takes this view's bar when it offers one.
  if (ctx.actions) {
    ctx.actions.replaceChildren(bar);
    root.append(screen, foot);
  } else root.append(bar, screen, foot);
  host.appendChild(root);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    // A terminal stays a dark screen in both themes: the ANSI colours programs print are chosen
    // for one, and a light terminal turns their yellows and whites unreadable.
    theme: { background: '#1b1b1d', foreground: '#f2f2f4', cursor: '#0a84ff', selectionBackground: 'rgba(10, 132, 255, 0.35)' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(screen);

  let socket: WebSocket | null = null;
  /** The last thing the hub said on this socket, which is what decides whether to dial again. */
  let notice: Notice | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const setBanner = (text: string): void => {
    banner.textContent = text;
    bar.classList.toggle('term__bar--warn', text !== '');
  };

  const resize = (): void => {
    try {
      fit.fit();
    } catch { /* the sheet is mid-open and the box has no size yet */ }
    if (socket?.readyState === WebSocket.OPEN) socket.send(resizeFrame(term.cols, term.rows));
  };

  const connect = (): void => {
    if (disposed) return;
    const next = new WebSocket(terminalUrl(window.location, ctx.slug));
    next.binaryType = 'arraybuffer';
    socket = next;

    next.addEventListener('open', () => {
      attempt = 0;
      notice = null;
      setBanner('');
      resize();
      term.focus();
    });
    next.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const said = parseNotice(event.data);
        if (!said) return;
        notice = said;
        setBanner(said.message);
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    });
    next.addEventListener('close', () => {
      if (disposed || socket !== next) return;
      socket = null;
      if (!reconnectAfter(notice, attempt)) {
        // The hub said why it ended this one, or the retries are spent. Either way the next shell
        // is the reader's call, not ours.
        if (!banner.textContent) setBanner('Disconnected — press New session to start another shell.');
        return;
      }
      setBanner('Connection lost — reconnecting…');
      const wait = reconnectDelay(attempt);
      attempt += 1;
      retry = setTimeout(() => {
        term.writeln('\r\n\x1b[2m— new session —\x1b[0m');
        connect();
      }, wait);
    });
  };

  // One socket at a time: the old one's close handler is disowned by the `socket !== next` check
  // above, so pressing this never leaves two shells running.
  restart.addEventListener('click', () => {
    clearTimeout(retry);
    attempt = 0;
    const old = socket;
    socket = null;
    notice = null;
    old?.close();
    term.reset();
    setBanner('');
    connect();
  });

  const observer = new ResizeObserver(() => resize());
  observer.observe(screen);
  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeInput(data));
  });

  // The sheet is on screen but the box may still be laying out; fit once it has.
  requestAnimationFrame(() => resize());
  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    observer.disconnect();
    socket?.close();
    socket = null;
    term.dispose();
    root.remove();
  };
}
