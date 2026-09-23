import { describe, it, expect, afterEach, vi } from 'vitest';
import type { UsageReport } from '@agenthub/shared';
import { openDb } from '../src/db.js';
import { createHub, type Hub } from '../src/server.js';
import { UsageStore, type UsageRow } from '../src/usage.js';
import { costUsd, priceFor, PRICES_AS_OF, FIREWORKS_MODELS } from '../src/providers/fireworks.js';

const FLASH = 'accounts/fireworks/models/glm-5p3-flash';
const KIMI = 'accounts/fireworks/models/kimi-k3';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  subject: 'demo', sessionId: 1, kind: 'orchestrator',
  provider: 'fireworks', node: 'cloud-fireworks', model: FLASH,
  promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0, usd: 0.15,
  ...over,
});

describe('priceFor', () => {
  it('prices every Fireworks model the hub offers, as of a stated date', () => {
    expect(PRICES_AS_OF).toBe('2026-09-23');
    for (const model of FIREWORKS_MODELS) {
      expect(priceFor('fireworks', model.id), model.id).not.toBeNull();
    }
    expect(priceFor('fireworks', FLASH)).toEqual({ input: 0.15, cachedInput: 0.03, output: 0.50 });
    expect(priceFor('fireworks', KIMI)).toEqual({ input: 3.00, cachedInput: 0.30, output: 15.00 });
  });

  it('bills local serving nothing and refuses to guess at Anthropic or an unknown id', () => {
    expect(priceFor('openai', 'qwen-local')).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(priceFor(undefined, 'qwen-local')).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(priceFor('anthropic', 'claude-opus-4-8')).toBeNull();
    expect(priceFor('fireworks', 'accounts/fireworks/models/not-a-model')).toBeNull();
  });
});

describe('costUsd', () => {
  it('bills the uncached remainder of the prompt at the full rate and the cached part at its own', () => {
    const price = priceFor('fireworks', FLASH)!;
    // 1M prompt of which 400k cached, 1M completion:
    // 0.6 * 0.15 + 0.4 * 0.03 + 1 * 0.50 = 0.09 + 0.012 + 0.50
    expect(costUsd(price, { promptTokens: 1_000_000, cachedTokens: 400_000, completionTokens: 1_000_000 }))
      .toBeCloseTo(0.602, 10);
  });

  it('charges the full input rate when nothing was cached, and nothing at all for an empty request', () => {
    const price = priceFor('fireworks', KIMI)!;
    expect(costUsd(price, { promptTokens: 2_000_000, cachedTokens: 0, completionTokens: 100_000 }))
      .toBeCloseTo(6 + 1.5, 10);
    expect(costUsd(price, { promptTokens: 0, cachedTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it('is null without a price — the caller records tokens and no dollars', () => {
    expect(costUsd(null, { promptTokens: 10, cachedTokens: 0, completionTokens: 5 })).toBeNull();
  });
});

describe('UsageStore', () => {
  it('records a row and totals it by model and by subject', () => {
    const store = new UsageStore(openDb(':memory:'));
    store.record(row({ at: 100, subject: 'demo', promptTokens: 1000, cachedTokens: 200, completionTokens: 500, usd: 0.25 }));
    store.record(row({ at: 200, subject: 'demo', model: KIMI, promptTokens: 100, cachedTokens: 0, completionTokens: 50, usd: 0.75 }));
    store.record(row({ at: 300, subject: 'other', promptTokens: 10, cachedTokens: 0, completionTokens: 5, usd: 0.1 }));

    const all = store.summary({ since: 0 });
    expect(all.usd).toBeCloseTo(1.1, 10);
    expect(all.tokens).toEqual({ prompt: 1110, cached: 200, completion: 555 });
    expect(all.byModel).toEqual([
      { provider: 'fireworks', model: FLASH, usd: 0.35, tokens: 1515 },
      { provider: 'fireworks', model: KIMI, usd: 0.75, tokens: 150 },
    ]);
    expect(all.bySubject).toEqual([
      { subject: 'demo', usd: 1, tokens: 1650 },
      { subject: 'other', usd: 0.1, tokens: 15 },
    ]);
  });

  it('narrows to one project, and to a window', () => {
    const store = new UsageStore(openDb(':memory:'));
    store.record(row({ at: 100, subject: 'demo', usd: 1 }));
    store.record(row({ at: 900, subject: 'demo', usd: 2 }));
    store.record(row({ at: 900, subject: 'other', usd: 4 }));

    expect(store.summary({ since: 0, subject: 'demo' }).usd).toBe(3);
    expect(store.summary({ since: 500 }).usd).toBe(6);
    expect(store.summary({ since: 500, subject: 'demo' }).usd).toBe(2);
    expect(store.summary({ since: 1000 })).toMatchObject({ usd: 0, byModel: [], bySubject: [] });
  });

  it('records the tokens of an unpriced model but no dollars for it', () => {
    const store = new UsageStore(openDb(':memory:'));
    store.record(row({ at: 10, provider: 'anthropic', model: 'claude-opus-4-8', node: 'cloud-anthropic', usd: null, promptTokens: 400, completionTokens: 100 }));
    store.record(row({ at: 20, usd: 0.5, promptTokens: 100, completionTokens: 0 }));

    const all = store.summary({ since: 0 });
    expect(all.usd).toBe(0.5);
    expect(all.tokens.prompt).toBe(500);
    expect(all.byModel.find((m) => m.provider === 'anthropic')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', usd: 0, tokens: 500 });
  });

  it('counts only cloud spend towards the cap, and only inside the window', () => {
    const store = new UsageStore(openDb(':memory:'));
    store.record(row({ at: 100, provider: 'openai', node: 'spark', model: 'qwen-local', usd: 0 }));
    store.record(row({ at: 100, usd: 1.5 }));
    store.record(row({ at: 900, usd: 2.5 }));

    expect(store.cloudUsdSince(0)).toBe(4);
    expect(store.cloudUsdSince(500)).toBe(2.5);
    expect(store.cloudUsdSince(1000)).toBe(0);
  });
});

describe('GET /api/usage/summary', () => {
  let hub: Hub | null = null;
  afterEach(async () => { await hub?.stop(); hub = null; });

  const ask = async (query = ''): Promise<UsageReport> => {
    const res = await hub!.app.inject({ method: 'GET', url: `/api/usage/summary${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as UsageReport;
  };

  it('answers the trailing day by default, narrows to a project, and reports where the cap stands', async () => {
    hub = createHub({ maxCloudUsdPerDay: 5 });
    const now = Date.now();
    hub.usage.record(row({ at: now - 1000, subject: 'demo', usd: 1.5, promptTokens: 300, cachedTokens: 100, completionTokens: 50 }));
    hub.usage.record(row({ at: now - 1000, subject: 'other', usd: 0.5, promptTokens: 10, cachedTokens: 0, completionTokens: 5 }));
    // Older than the trailing 24h, so neither the default window nor the cap counts it.
    hub.usage.record(row({ at: now - 48 * 60 * 60_000, subject: 'demo', usd: 99 }));

    const all = await ask();
    expect(all.usd).toBe(2);
    expect(all.tokens).toEqual({ prompt: 310, cached: 100, completion: 55 });
    expect(all.bySubject.map((r) => r.subject).sort()).toEqual(['demo', 'other']);
    expect(all.cap).toEqual({ maxCloudUsdPerDay: 5, cloudUsdToday: 2 });

    const demo = await ask('?project=demo');
    expect(demo.usd).toBe(1.5);
    expect(demo.bySubject).toEqual([{ subject: 'demo', usd: 1.5, tokens: 350 }]);
    // The cap is hub-wide however the summary was narrowed.
    expect(demo.cap.cloudUsdToday).toBe(2);

    // An explicit `since` reaches back past the default window; the cap keeps its own.
    expect((await ask('?since=0')).usd).toBe(101);
    expect((await ask('?since=0')).cap.cloudUsdToday).toBe(2);
    expect((await hub.app.inject({ method: 'GET', url: '/api/usage/summary?since=nope' })).statusCode).toBe(400);
    // A repeated parameter arrives as an array, which neither field can be.
    expect((await hub.app.inject({ method: 'GET', url: '/api/usage/summary?project=a&project=b' })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: 'GET', url: '/api/usage/summary?since=1&since=2' })).statusCode).toBe(400);
  });

  it('spends nothing in the cloud at a cap of zero', async () => {
    const savedKey = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = 'fw-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A configured cloud tier, so there is genuinely an endpoint for the cap to take away.
      hub = createHub({ cloud: { fireworks: { baseUrl: 'http://127.0.0.1:1' } }, maxCloudUsdPerDay: 0 });
      expect(hub.registry.online().map((n) => n.name)).toContain('cloud-fireworks');
      expect((await ask()).cap).toEqual({ maxCloudUsdPerDay: 0, cloudUsdToday: 0 });
      // Nothing spent yet and already at the cap: the cloud is out of rotation from the start.
      expect(hub.gateway.pick('orchestrator')).toBeNull();
    } finally {
      warn.mockRestore();
      if (savedKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = savedKey;
    }
  });

  it('keeps the cloud in rotation when no cap is set', async () => {
    const savedKey = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = 'fw-secret';
    try {
      hub = createHub({ cloud: { fireworks: { baseUrl: 'http://127.0.0.1:1' } } });
      expect(hub.gateway.pick('orchestrator')?.node.name).toBe('cloud-fireworks');
    } finally {
      if (savedKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = savedKey;
    }
  });

  it('reports a null cap when the owner has set none', async () => {
    hub = createHub();
    expect((await ask()).cap).toEqual({ maxCloudUsdPerDay: null, cloudUsdToday: 0 });
  });
});
