import { MAX_LINKS, MAX_TEXT, type BrowserDriver, type PageLink, type PageRead, type PageState } from './driver.js';

/**
 * Playwright is not a dependency of this package — the Mac mini installs it (see
 * deploy/macmini/README.md) and every other node runs the daemon without it. So the module is
 * imported through a non-literal specifier (no static resolution, no build-time type dependency)
 * and described here by the handful of members this driver actually uses.
 */
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts: { type: 'jpeg'; quality?: number }): Promise<Buffer>;
  waitForLoadState(state?: string): Promise<void>;
}
interface PwContext { newPage(): Promise<PwPage> }
/** The sliver of the DOM `read()` touches, typed here because this package compiles without lib.dom. */
interface PageDocument { querySelectorAll(selector: string): Iterable<{ textContent: string | null; href: string }> }
interface PwBrowser {
  newContext(opts: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule { chromium: { launch(opts: { headless: boolean; env?: NodeJS.ProcessEnv }): Promise<PwBrowser> } }

export interface PlaywrightDriverOptions {
  /** Headed on the Mac mini's virtual-HDMI display; headless everywhere else. */
  headless?: boolean;
  /** X/virtual display to render on, exported as DISPLAY to the browser process. */
  display?: string;
}

// A 1280×720 viewport at half scale renders a usable page and still screenshots at 640×360, the
// cap the hub relays to the UI.
const VIEWPORT = { width: 1280, height: 720 };
const SCALE = 0.5;
const JPEG_QUALITY = 60;
const ACTION_TIMEOUT_MS = 15_000;

class PlaywrightDriver implements BrowserDriver {
  constructor(private browser: PwBrowser, private page: PwPage) {}

  private async state(): Promise<PageState> {
    return { url: this.page.url(), title: await this.page.title() };
  }

  async navigate(url: string): Promise<PageState> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
    return this.state();
  }

  async read(): Promise<PageRead> {
    const text = await this.page.innerText('body');
    // Runs in the page, so the DOM is only reachable through globalThis (this package compiles
    // without the DOM lib).
    const links = await this.page.evaluate<PageLink[]>(() => {
      const { document } = globalThis as unknown as { document: PageDocument };
      return [...document.querySelectorAll('a[href]')].map((a) => ({
        text: (a.textContent ?? '').trim().slice(0, 120),
        href: a.href,
      }));
    });
    return { state: await this.state(), text: text.slice(0, MAX_TEXT), links: links.slice(0, MAX_LINKS) };
  }

  async click(selector: string): Promise<PageState> {
    await this.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    await this.page.waitForLoadState('domcontentloaded');
    return this.state();
  }

  async type(selector: string, text: string, submit?: boolean): Promise<PageState> {
    await this.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) {
      await this.page.keyboard.press('Enter');
      await this.page.waitForLoadState('domcontentloaded');
    }
    return this.state();
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Launches Chromium and returns a driver for its single page. Throws if playwright isn't installed. */
export async function createPlaywrightDriver(opts: PlaywrightDriverOptions = {}): Promise<BrowserDriver> {
  const specifier = 'playwright';
  const { chromium } = (await import(specifier)) as PwModule;
  const browser = await chromium.launch({
    headless: opts.headless ?? true,
    ...(opts.display ? { env: { ...process.env, DISPLAY: opts.display } } : {}),
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  return new PlaywrightDriver(browser, await context.newPage());
}
