import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { button, el } from '../dom.js';
import type { ViewContext } from './parts.js';
import { type Notice, parseNotice, reconnectAfter, reconnectDelay, resizeFrame, encodeInput, terminalUrl } from './terminal.js';

const FOOTER = 'shell in workspace/ on the hub host · owner only';

/** The xterm half of the Terminal sheet; `mountTerminal` in `terminal.ts` loads this lazily. */
export function mountTerminalScreen(host: HTMLElement, ctx: ViewContext): () => void {
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
