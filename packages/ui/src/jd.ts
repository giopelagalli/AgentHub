import type { JdMessage } from '@agenthub/shared';

/**
 * The JD page's logic that needs no page: rendering JD's text safely, folding new messages and
 * edits into the conversation, when to show a time between bubbles, how long to wait before
 * reconnecting the stream, and which audio container to record in. `pages/jd.ts` is the DOM.
 */

/** Telegram's HTML subset (0069), each tag mapped to the one element the page renders it as. */
const ALLOWED: Record<string, 'b' | 'i' | 'u' | 's' | 'code' | 'pre' | 'a'> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's', code: 'code', pre: 'pre', a: 'a',
};

/** Elements whose content is not text anyone meant to read: dropped whole, never shown. */
const DROPPED = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title']);

/** An absolute http(s) URL, normalised, or null for anything else (`javascript:`, `data:`, relative). */
export function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A message's text as DOM the page can append, built through an allow-list rather than cleaned up:
 * JD's string is parsed into an inert document (`DOMParser` runs no script and loads nothing), then
 * walked, and only `b i u s code pre a[href]` are recreated — fresh elements carrying no attribute
 * but a vetted link's. Any other element gives up its text and nothing else; `script` and kin give
 * up nothing. No string ever reaches `innerHTML`.
 */
export function renderJdText(message: Pick<JdMessage, 'text' | 'format'>, doc: Document = document): DocumentFragment {
  const out = doc.createDocumentFragment();
  if (message.format !== 'html') {
    out.appendChild(doc.createTextNode(message.text));
    return out;
  }
  const parsed = new DOMParser().parseFromString(`<!doctype html><html><body>${message.text}</body></html>`, 'text/html');
  rebuild(parsed.body, out, doc);
  return out;
}

function rebuild(from: Node, into: Node, doc: Document): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === 3) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.localName;
    if (DROPPED.has(tag)) continue;
    if (tag === 'br') {
      into.appendChild(doc.createTextNode('\n'));
      continue;
    }
    const kind = ALLOWED[tag];
    if (!kind) {
      rebuild(element, into, doc);
      continue;
    }
    let made: HTMLElement;
    if (kind === 'a') {
      const href = safeHref(element.getAttribute('href'));
      if (!href) {
        rebuild(element, into, doc);
        continue;
      }
      const link = doc.createElement('a');
      link.href = href;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      made = link;
    } else {
      made = doc.createElement(kind);
    }
    rebuild(element, made, doc);
    into.appendChild(made);
  }
}

/**
 * The conversation with `incoming` folded in: a message whose id is already there replaces it (an
 * `edit: true` always means that), a new one is added, an edit of a message this page never had is
 * dropped. Kept in time order; the `edit` flag itself is not kept.
 */
export function mergeMessages(list: readonly JdMessage[], incoming: readonly JdMessage[]): JdMessage[] {
  const next = [...list];
  for (const message of incoming) {
    const { edit, ...stored } = message;
    const at = next.findIndex((m) => m.id === message.id);
    if (at >= 0) next[at] = stored;
    else if (!edit) next.push(stored);
  }
  return next.map((m, i) => [m, i] as const)
    .sort(([a, i], [b, j]) => a.at - b.at || i - j)
    .map(([m]) => m);
}

/** A gap this long between two bubbles puts the time between them, as Messages does. */
export const STAMP_GAP_MS = 15 * 60 * 1000;

export function needsStamp(previous: JdMessage | undefined, message: JdMessage): boolean {
  if (!previous) return true;
  return message.at - previous.at >= STAMP_GAP_MS || new Date(previous.at).toDateString() !== new Date(message.at).toDateString();
}

/** "Today 09:41", "Yesterday 18:02", "Mon 3 Oct 09:41". */
export function stampLabel(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (when.toDateString() === today.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (when.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** Two bubbles from the same side this close together read as one run, with tighter corners. */
export const RUN_GAP_MS = 2 * 60 * 1000;

export function sameRun(a: JdMessage | undefined, b: JdMessage | undefined): boolean {
  return !!a && !!b && a.from === b.from && Math.abs(b.at - a.at) < RUN_GAP_MS;
}

/** The wait before reconnect number `attempt` (0-based): 1 s doubling to 30 s, with a little jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.85 + random() * 0.3));
}

/**
 * The container to record a voice note in, best first: Opus in WebM (Chrome, Firefox), then MP4
 * (Safari, which records nothing else), then Ogg. Empty when the browser offers none of them and
 * should pick for itself.
 */
export function pickRecordingType(supported: (type: string) => boolean): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'].find(supported) ?? '';
}

/** The `Content-Type` a recording goes up with: its container, without codec parameters. */
export function uploadType(recorded: string): string {
  return recorded.split(';')[0]!.trim() || 'audio/webm';
}

/** `m:ss` for a recording or a voice note's length. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
