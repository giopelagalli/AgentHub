/**
 * Fireworks AI as a cloud tier. Unlike Anthropic there is no SDK here: Fireworks speaks the same
 * OpenAI-compatible wire format the gateway already uses for local endpoints, so the only thing
 * this module owns is the base url, the model defaults, and the model list.
 */

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

export interface FireworksModel { id: string; hard: boolean }

/**
 * Every Fireworks model the hub will use. `hard` ones are the expensive tier, off unless the owner
 * sets FIREWORKS_HARD_MODELS=1.
 */
export const FIREWORKS_MODELS: readonly FireworksModel[] = [
  { id: 'accounts/fireworks/models/glm-5p3-flash', hard: false },
  { id: 'accounts/fireworks/models/deepseek-v4p1-flash', hard: false },
  { id: 'accounts/fireworks/models/glm-5p3', hard: true },
  { id: 'accounts/fireworks/models/kimi-k3', hard: true },
];

/** The ids the hub offers right now, and the ones it knows but refuses (hard models while the switch is off). */
export function fireworksModels(hardModels: boolean): { enabled: string[]; disabled: string[] } {
  if (hardModels) return { enabled: FIREWORKS_MODELS.map((m) => m.id), disabled: [] };
  return {
    enabled: FIREWORKS_MODELS.filter((m) => !m.hard).map((m) => m.id),
    disabled: FIREWORKS_MODELS.filter((m) => m.hard).map((m) => m.id),
  };
}
