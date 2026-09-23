/**
 * Fireworks AI as a cloud tier. Unlike Anthropic there is no SDK here: Fireworks speaks the same
 * OpenAI-compatible wire format the gateway already uses for local endpoints, so the only thing
 * this module owns is the base url, the model defaults, the model list, and their prices.
 */
import type { ModelPrice, TokenUsage } from '@agenthub/shared';

/** The gateway appends `/v1/chat/completions`, so the base stops one segment short of `/v1`. */
export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference';

/** The env var the synthetic `cloud-fireworks` node's endpoints name in `apiKeyEnv`. */
export const FIREWORKS_API_KEY_ENV = 'FIREWORKS_API_KEY';

/**
 * Tier defaults for the synthetic Fireworks node.
 *
 * Both GLM ids were confirmed against the account's own catalog; `deepseek-v4p1-flash` and
 * `kimi-k3` come from Fireworks' model pages. `FIREWORKS_ORCHESTRATOR_MODEL` /
 * `FIREWORKS_WORKER_MODEL` override them without a code change.
 */
export const DEFAULT_FIREWORKS_ORCHESTRATOR_MODEL = 'accounts/fireworks/models/glm-5p3-flash';
export const DEFAULT_FIREWORKS_WORKER_MODEL = 'accounts/fireworks/models/glm-5p3-flash';

export interface FireworksModel {
  id: string;
  hard: boolean;
  /** USD per million tokens. Absent means the hub has no price and records `usd: null`. */
  price?: ModelPrice;
}

/**
 * When the prices below were read off Fireworks' pricing page (Standard serverless). Shown wherever
 * a cost is; a price that moved is a code change, never a guess.
 */
export const PRICES_AS_OF = '2026-09-23';

/**
 * Every Fireworks model the hub will use. `hard` ones are the expensive tier, off unless the owner
 * sets FIREWORKS_HARD_MODELS=1.
 */
export const FIREWORKS_MODELS: readonly FireworksModel[] = [
  { id: 'accounts/fireworks/models/glm-5p3-flash', hard: false, price: { input: 0.15, cachedInput: 0.03, output: 0.50 } },
  { id: 'accounts/fireworks/models/deepseek-v4p1-flash', hard: false, price: { input: 0.22, cachedInput: 0.007, output: 0.66 } },
  { id: 'accounts/fireworks/models/glm-5p3', hard: true, price: { input: 1.40, cachedInput: 0.26, output: 4.40 } },
  { id: 'accounts/fireworks/models/kimi-k3', hard: true, price: { input: 3.00, cachedInput: 0.30, output: 15.00 } },
];

/** Hardware the owner already paid for bills nothing per token. */
const FREE: ModelPrice = { input: 0, cachedInput: 0, output: 0 };

/**
 * What one model costs on the endpoint serving it, or null when the hub has no price for it.
 *
 * Fireworks is the only provider with a price table, so it lives here and this function answers for
 * all three: a local (`openai`) endpoint is free, and Anthropic has no table yet — its tokens are
 * recorded with `usd: null` rather than guessed at.
 */
export function priceFor(provider: string | undefined, model: string): ModelPrice | null {
  if ((provider ?? 'openai') === 'openai') return FREE;
  if (provider !== 'fireworks') return null;
  return FIREWORKS_MODELS.find((m) => m.id === model)?.price ?? null;
}

/**
 * What a request's tokens cost at `price`, or null when there is no price. `cachedTokens` is a
 * subset of `promptTokens`, so only the uncached remainder is billed at the full input rate.
 */
export function costUsd(price: ModelPrice | null, usage: TokenUsage): number | null {
  if (!price) return null;
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (fresh * price.input + usage.cachedTokens * price.cachedInput + usage.completionTokens * price.output) / 1e6;
}

/** The ids the hub offers right now, and the ones it knows but refuses (hard models while the switch is off). */
export function fireworksModels(hardModels: boolean): { enabled: string[]; disabled: string[] } {
  if (hardModels) return { enabled: FIREWORKS_MODELS.map((m) => m.id), disabled: [] };
  return {
    enabled: FIREWORKS_MODELS.filter((m) => !m.hard).map((m) => m.id),
    disabled: FIREWORKS_MODELS.filter((m) => m.hard).map((m) => m.id),
  };
}
