/** Where the browser currently is — every action returns it so callers stay oriented. */
export interface PageState { url: string; title: string }

export interface PageLink { text: string; href: string }

export interface PageRead {
  state: PageState;
  /** Visible text, truncated to MAX_TEXT chars. */
  text: string;
  /** First MAX_LINKS links on the page. */
  links: PageLink[];
}

/** Caps that keep a page read inside a model's context. Enforced by every driver. */
export const MAX_TEXT = 20_000;
export const MAX_LINKS = 100;

/**
 * One browser tab, driven by whoever holds the lease. Implemented by `PlaywrightDriver` on the Mac
 * mini and by `FakeDriver` in tests; `browser/server.ts` is the only consumer.
 */
export interface BrowserDriver {
  navigate(url: string): Promise<PageState>;
  read(): Promise<PageRead>;
  /** CSS selector or `text=...`. */
  click(selector: string): Promise<PageState>;
  type(selector: string, text: string, submit?: boolean): Promise<PageState>;
  /** JPEG, at most 640px wide. */
  screenshot(): Promise<Buffer>;
  /** Starts the slot over in a fresh, empty session — the hub's call when the slot changes project. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A 1×1 baseline JPEG — what `FakeDriver.screenshot()` always returns. */
export const FAKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

/** A page in `FakeDriver`'s in-memory web. */
export interface FakePage { title: string; text: string; links?: PageLink[] }

export interface FakeCall { op: 'navigate' | 'read' | 'click' | 'type' | 'screenshot' | 'reset' | 'close'; args: unknown[] }

const BLANK: FakePage = { title: '(blank)', text: '', links: [] };

/**
 * In-memory stand-in for a real browser: a url→page map plus a call log for assertions. Never
 * throws — an unknown url lands on a blank page and an unmatched selector is a no-op — so tests
 * that only care about the wiring don't have to model a whole site.
 */
export class FakeDriver implements BrowserDriver {
  readonly calls: FakeCall[] = [];
  private pages = new Map<string, FakePage>();
  private current = 'about:blank';
  closed = false;

  constructor(pages: Record<string, FakePage> = {}) {
    for (const [url, page] of Object.entries(pages)) this.pages.set(url, page);
  }

  setPage(url: string, page: FakePage): void { this.pages.set(url, page); }

  private page(): FakePage { return this.pages.get(this.current) ?? BLANK; }
  private state(): PageState { return { url: this.current, title: this.page().title }; }

  async navigate(url: string): Promise<PageState> {
    this.calls.push({ op: 'navigate', args: [url] });
    this.current = url;
    return this.state();
  }

  async read(): Promise<PageRead> {
    this.calls.push({ op: 'read', args: [] });
    const page = this.page();
    return { state: this.state(), text: page.text.slice(0, MAX_TEXT), links: (page.links ?? []).slice(0, MAX_LINKS) };
  }

  /** Follows a link whose href or `text=<label>` matches; anything else leaves the page as it is. */
  async click(selector: string): Promise<PageState> {
    this.calls.push({ op: 'click', args: [selector] });
    const label = selector.startsWith('text=') ? selector.slice('text='.length) : null;
    const link = (this.page().links ?? []).find((l) => (label === null ? l.href === selector : l.text === label));
    if (link) this.current = link.href;
    return this.state();
  }

  async type(selector: string, text: string, submit?: boolean): Promise<PageState> {
    this.calls.push({ op: 'type', args: [selector, text, submit ?? false] });
    return this.state();
  }

  async screenshot(): Promise<Buffer> {
    this.calls.push({ op: 'screenshot', args: [] });
    return FAKE_JPEG;
  }

  async reset(): Promise<void> {
    this.calls.push({ op: 'reset', args: [] });
    this.current = 'about:blank';
  }

  async close(): Promise<void> {
    this.calls.push({ op: 'close', args: [] });
    this.closed = true;
  }
}
