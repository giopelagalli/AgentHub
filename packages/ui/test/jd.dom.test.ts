// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JdMessage } from '@agenthub/shared';
import { backoffMs, mergeMessages, pickRecordingType, renderJdText, safeHref, uploadType } from '../src/jd.js';
import { mountJd } from '../src/pages/jd.js';
import { Store } from '../src/store.js';

/**
 * The JD page (FR-C4) in a DOM: JD's HTML through the allow-list, the conversation's folding of
 * edits, inline buttons → `/callback` → the edit applied, quick keys, and the setup empty state.
 * The hub is a stubbed `fetch`; the stream is left off.
 */

const html = (text: string): HTMLElement => {
  const box = document.createElement('div');
  box.appendChild(renderJdText({ text, format: 'html' }));
  return box;
};

describe('renderJdText', () => {
  it('keeps b i u s code pre and safe links, and nothing else', () => {
    const box = html('<b>bold</b> <strong>s</strong> <i>it</i> <u>u</u> <s>x</s> <code>c</code><pre>p</pre> <a href="https://example.com/a?b=1">link</a>');
    expect([...box.children].map((c) => c.localName)).toEqual(['b', 'b', 'i', 'u', 's', 'code', 'pre', 'a']);
    const link = box.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
  });

  it('strips script, event handlers and javascript: links', () => {
    const box = html('hi<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"><b onclick="x()" style="color:red">b</b>'
      + '<a href="javascript:alert(1)">js</a><a href=" JAVASCRIPT:alert(1)">js2</a><a href="data:text/html,x">data</a><a href="/relative">rel</a>');
    expect(box.querySelector('script, img, style')).toBeNull();
    expect(box.querySelectorAll('a')).toHaveLength(0);
    expect(box.textContent).toBe('hibjsjs2datarel');
    const b = box.querySelector('b')!;
    expect(b.attributes).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    for (const node of box.querySelectorAll('*')) {
      for (const attr of node.attributes) expect(attr.name.startsWith('on')).toBe(false);
    }
  });

  it('shows an unknown tag’s text, decodes entities, and keeps newlines', () => {
    const box = html('<span class="tg-spoiler">secret</span> &lt;b&gt; 1 &amp; 2<br>next\nline');
    expect(box.querySelector('span')).toBeNull();
    expect(box.textContent).toBe('secret <b> 1 & 2\nnext\nline');
  });

  it('renders plain text as text, markup and all', () => {
    const box = document.createElement('div');
    box.appendChild(renderJdText({ text: '<b>not bold</b>', format: 'plain' }));
    expect(box.children).toHaveLength(0);
    expect(box.textContent).toBe('<b>not bold</b>');
  });

  it('only lets http and https through as links', () => {
    expect(safeHref('https://x.dev/')).toBe('https://x.dev/');
    expect(safeHref('http://x.dev')).toBe('http://x.dev/');
    expect(safeHref('mailto:a@b.c')).toBeNull();
    expect(safeHref('//x.dev')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

const msg = (id: string, at: number, extra: Partial<JdMessage> = {}): JdMessage =>
  ({ id, from: 'jd', at, text: id, format: 'plain', ...extra });

describe('the conversation', () => {
  it('applies an edit in place, adds new messages in time order, and ignores an edit of an unknown one', () => {
    const list = [msg('a', 1), msg('b', 3)];
    const next = mergeMessages(list, [msg('c', 2), { ...msg('b', 3), text: 'B!', edit: true }, { ...msg('zz', 9), edit: true }]);
    expect(next.map((m) => m.id)).toEqual(['a', 'c', 'b']);
    expect(next[2]).toEqual({ ...msg('b', 3), text: 'B!' });
    expect('edit' in next[2]!).toBe(false);
  });

  it('backs off from 1 s to 30 s', () => {
    const mid = () => 0.5;
    expect(backoffMs(0, mid)).toBe(1000);
    expect(backoffMs(3, mid)).toBe(8000);
    expect(backoffMs(20, mid)).toBe(30000);
  });

  it('records in what the browser has, best first, and uploads the bare container type', () => {
    expect(pickRecordingType((t) => t === 'audio/mp4' || t === 'audio/ogg')).toBe('audio/mp4');
    expect(pickRecordingType(() => false)).toBe('');
    expect(uploadType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(uploadType('')).toBe('audio/webm');
  });
});

/** A fetch that answers JD's routes from a table, and remembers what was asked. */
function stubHub(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0]!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the JD page', () => {
  let teardown: (() => void) | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  const mount = (): HTMLElement => {
    const host = document.createElement('main');
    document.body.appendChild(host);
    teardown = mountJd(host, new Store(), { openStream: null });
    return host;
  };

  it('explains the two .env lines when JD is not configured, and shows no secret', async () => {
    stubHub({ 'GET /api/jd/status': () => ({ configured: false, reachable: false }) });
    const host = mount();
    await settle();
    expect(host.querySelector('.jd__noticehead')?.textContent).toBe('Connect JD');
    const lines = host.querySelector('.jd__envlines')!.textContent!;
    expect(lines).toContain('JD_URL=http://127.0.0.1:8891');
    expect(lines).toMatch(/JD_WEB_TOKEN=…$/);
    expect(host.querySelector('.jd__composer')).toBeNull();
  });

  it('turns a tap on JD’s button into a callback and applies the edit it answers', async () => {
    const keyboard = msg('k1', 1000, { text: 'How did it go?', format: 'html', buttons: [[{ label: 'Great', data: 'mood:great' }, { label: 'Rough', data: 'mood:rough' }]] });
    const calls = stubHub({
      'GET /api/jd/status': () => ({ configured: true, reachable: true, name: 'Jarvis' }),
      'GET /api/jd/history': () => ({ messages: [msg('h1', 500, { from: 'owner', text: 'hello' }), keyboard] }),
      'GET /api/jd/keys': () => ({ keys: [] }),
      'POST /api/jd/callback': () => ({ messages: [{ ...keyboard, buttons: undefined, text: 'How did it go? <i>Great.</i>', edit: true }] }),
    });
    const host = mount();
    await settle();
    expect(host.querySelector('.jd__name')?.textContent).toBe('Jarvis');
    const pills = [...host.querySelectorAll<HTMLButtonElement>('.jd__btn')];
    expect(pills.map((p) => p.textContent)).toEqual(['Great', 'Rough']);
    expect(host.querySelector('.jd__msg--owner')?.textContent).toBe('hello');

    pills[0]!.click();
    expect(pills.every((p) => p.disabled)).toBe(true);
    await settle();
    expect(calls.find((c) => c.url === '/api/jd/callback')?.body).toEqual({ data: 'mood:great' });
    expect(host.querySelectorAll('.jd__btn')).toHaveLength(0);
    const bubbles = [...host.querySelectorAll('.jd__msg--jd .jd__text')];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.querySelector('i')?.textContent).toBe('Great.');
  });

  it('sends a quick key as text and shows JD’s answer', async () => {
    const calls = stubHub({
      'GET /api/jd/status': () => ({ configured: true, reachable: true }),
      'GET /api/jd/history': () => ({ messages: [] }),
      'GET /api/jd/keys': () => ({ keys: ['Plan my day', 'Projects'] }),
      'POST /api/jd/messages': (body) => ({
        messages: [msg('o1', 1, { from: 'owner', text: (body as { text: string }).text }), msg('r1', 2, { text: '<b>Here</b> it is', format: 'html' })],
      }),
    });
    const host = mount();
    await settle();
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.jd__key')];
    expect(chips.map((c) => c.textContent)).toEqual(['Plan my day', 'Projects']);
    expect(host.querySelector('.jd__hello')?.textContent).toContain('quick key');

    chips[0]!.click();
    await settle();
    expect(calls.find((c) => c.url === '/api/jd/messages')?.body).toEqual({ text: 'Plan my day' });
    expect(host.querySelector('.jd__msg--owner .jd__text')?.textContent).toBe('Plan my day');
    expect(host.querySelector('.jd__msg--jd b')?.textContent).toBe('Here');
    expect(host.querySelector('.jd__msg--pending, .jd__typing, .jd__hello')).toBeNull();
  });

  it('sends what is typed on Enter, and swaps the mic for send while there is text', async () => {
    const calls = stubHub({
      'GET /api/jd/status': () => ({ configured: true, reachable: true }),
      'GET /api/jd/history': () => ({ messages: [] }),
      'GET /api/jd/keys': () => ({ keys: [] }),
      'POST /api/jd/messages': () => ({ messages: [] }),
    });
    const host = mount();
    await settle();
    const input = host.querySelector<HTMLTextAreaElement>('.jd__input')!;
    const action = host.querySelector<HTMLButtonElement>('.jd__action')!;
    expect(action.getAttribute('aria-label')).toBe('Record a voice note');
    input.value = 'remind me at 5';
    input.dispatchEvent(new Event('input'));
    expect(action.getAttribute('aria-label')).toBe('Send');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(calls.find((c) => c.url === '/api/jd/messages')?.body).toEqual({ text: 'remind me at 5' });
    expect(input.value).toBe('');
  });

  it('says which: a token JD refuses, or a hub with no password', async () => {
    stubHub({ 'GET /api/jd/status': () => ({ configured: true, reachable: false, reason: 'token' }) });
    let host = mount();
    await settle();
    expect(host.querySelector('.jd__noticehead')?.textContent).toBe('The token doesn’t match');
    expect(host.querySelector('.jd__notice')?.textContent).toContain('JD_WEB_TOKEN');
    teardown!();
    vi.unstubAllGlobals();

    stubHub({ 'GET /api/jd/status': () => ({ configured: false, reachable: false, reason: 'no-password' }) });
    host = mount();
    await settle();
    expect(host.querySelector('.jd__noticehead')?.textContent).toBe('Set a hub password first');
    expect(host.querySelector('.jd__envlines')).toBeNull();
  });

  it('says so when JD is configured but not answering', async () => {
    stubHub({ 'GET /api/jd/status': () => ({ configured: true, reachable: false }) });
    const host = mount();
    await settle();
    expect(host.querySelector('.jd__noticehead')?.textContent).toContain('isn’t answering');
    expect(host.querySelector('.jd__notice .btn')?.textContent).toBe('Try again');
  });

  describe('the stream', () => {
    /** A socket the test opens and drops by hand. */
    class FakeSocket extends EventTarget {
      close = vi.fn();
      open(): void { this.dispatchEvent(new Event('open')); }
      drop(reason = ''): void { this.dispatchEvent(Object.assign(new Event('close'), { code: 1011, reason })); }
    }
    const chatHub = () => stubHub({
      'GET /api/jd/status': () => ({ configured: true, reachable: true }),
      'GET /api/jd/history': () => ({ messages: [] }),
      'GET /api/jd/keys': () => ({ keys: [] }),
    });
    const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };

    function mountWithStream(): { host: HTMLElement; sockets: FakeSocket[] } {
      const sockets: FakeSocket[] = [];
      const host = document.createElement('main');
      document.body.appendChild(host);
      teardown = mountJd(host, new Store(), {
        openStream: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      });
      return { host, sockets };
    }

    it('reconnects after a close, reloads history, and stops for good on unmount', async () => {
      vi.useFakeTimers();
      const calls = chatHub();
      const { host, sockets } = mountWithStream();
      await flush();
      expect(sockets).toHaveLength(1);
      sockets[0]!.open();
      expect(host.querySelector('.jd__sub')?.textContent).toBe('Online');

      sockets[0]!.drop();
      expect(host.querySelector('.jd__sub')?.textContent).toBe('Reconnecting…');
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await flush();
      expect(calls.filter((c) => c.url.startsWith('/api/jd/history'))).toHaveLength(2);

      teardown!();
      teardown = undefined;
      expect(sockets[1]!.close).toHaveBeenCalled();
      sockets[1]!.drop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sockets).toHaveLength(2);
    });

    it('gives up and says so when the hub closes the stream over the token', async () => {
      vi.useFakeTimers();
      chatHub();
      const { host, sockets } = mountWithStream();
      await flush();
      sockets[0]!.open();
      sockets[0]!.drop('JD refused the hub’s token');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sockets).toHaveLength(1);
      expect(host.querySelector('.jd__noticehead')?.textContent).toBe('The token doesn’t match');
    });

    it('says JD is not answering while it retries', async () => {
      vi.useFakeTimers();
      chatHub();
      const { host, sockets } = mountWithStream();
      await flush();
      sockets[0]!.drop('JD is not reachable');
      expect(host.querySelector('.jd__sub')?.textContent).toBe('Not answering — retrying…');
    });
  });
});
