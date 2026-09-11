/**
 * Fireworks AI as a cloud tier. Unlike Anthropic there is no SDK here: Fireworks speaks the same
 * OpenAI-compatible wire format the gateway already uses for local endpoints, so the only thing
 * this module owns is the base url, the model defaults, and the model catalog.
 */

/** The gateway appends `/v1/chat/completions`, so the base stops one segment short of `/v1`. */
export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference';

/** The env var the synthetic `cloud-fireworks` node's endpoints name in `apiKeyEnv`. */
export const FIREWORKS_API_KEY_ENV = 'FIREWORKS_API_KEY';

/**
 * Tier defaults for the synthetic Fireworks node.
 *
 * UNVERIFIED: these follow Fireworks' documented `accounts/<account>/models/<model>` naming, but no
 * request has confirmed the two ids exist. `GET /api/models` is the source of truth — it lists what
 * the account can actually serve — and `FIREWORKS_ORCHESTRATOR_MODEL` / `FIREWORKS_WORKER_MODEL`
 * override them without a code change.
 */
export const DEFAULT_FIREWORKS_ORCHESTRATOR_MODEL = 'accounts/fireworks/models/glm-5p3';
export const DEFAULT_FIREWORKS_WORKER_MODEL = 'accounts/fireworks/models/glm-5p3-flash';

/** How long a fetched catalog is reused before the next request refetches it. */
export const CATALOG_TTL_MS = 10 * 60_000;

/** How long a catalog fetch waits before giving up on a Fireworks that never answers. */
export const CATALOG_FETCH_TIMEOUT_MS = 5_000;

interface CatalogEntry {
  id?: unknown;
  supports_chat?: unknown;
}

/**
 * The chat-capable model ids Fireworks lists, sorted, cached for `CATALOG_TTL_MS`.
 *
 * An entry counts as chat-capable unless it says otherwise (`supports_chat: false`) — the field is
 * absent on plenty of entries, and dropping everything unlabelled would empty the catalog. A failed
 * fetch costs one log line and an empty list: the owner still gets the rest of `/api/models`, and
 * nothing is cached, so the next request tries again.
 */
export class FireworksCatalog {
  private cached: { at: number; models: string[] } | undefined;
  private inFlight: Promise<string[]> | undefined;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    baseUrl?: string; now?: () => number; log?: (line: string) => void; fetchImpl?: typeof fetch; timeoutMs?: number;
  } = {}) {
    this.baseUrl = opts.baseUrl ?? FIREWORKS_BASE_URL;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS;
  }

  async models(apiKey: string | undefined): Promise<string[]> {
    const fresh = this.cached && this.now() - this.cached.at < CATALOG_TTL_MS;
    if (fresh) return this.cached!.models;
    if (!apiKey) return [];
    // Two owners' requests arriving together share one fetch rather than racing two.
    this.inFlight ??= this.fetch(apiKey).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async fetch(apiKey: string): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`fireworks replied ${res.status}`);
      const body = await res.json() as { data?: CatalogEntry[] };
      const models = (body.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.supports_chat !== false)
        .map((m) => m.id as string)
        .sort();
      this.cached = { at: this.now(), models };
      return models;
    } catch (err) {
      this.log(`[fireworks] could not list models: ${(err as Error).message}`);
      return [];
    }
  }
}
