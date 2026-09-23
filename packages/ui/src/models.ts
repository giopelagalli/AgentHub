import type { CloudProvider, ModelCatalog, ModelPolicy } from '@agenthub/shared';

/**
 * The model picker's vocabulary: the `<select>` option list built from `GET /api/models`, the
 * mapping between an option value and the `modelPolicy` it posts, and the short label the pill and
 * the allocation table show. Pure — the DOM lives in `pages/projects.ts`.
 *
 * Option values are `auto` | `local` | `cloud` | `cloud:<provider>` | `cloud:<provider>:<model id>`.
 * Model ids carry slashes but no colons, so the third field is simply the rest of the string.
 */
export interface ModelOption { value: string; label: string; disabled?: boolean }

export const AUTO_VALUE = 'auto';
export const LOCAL_VALUE = 'local';
/** The worker select's "leave it to the orchestrator's model" entry. */
export const SAME_AS_ORCHESTRATOR = '';

/** `accounts/fireworks/models/glm-5p3` → `glm-5p3`; ids with no slash are already short. */
export function shortModel(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

export function providerLabel(provider: CloudProvider): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Every choice the owner has: the two local-first modes, then each configured cloud's models. */
export function modelOptions(catalog: ModelCatalog | null): ModelOption[] {
  const options: ModelOption[] = [
    { value: AUTO_VALUE, label: 'Auto (local first)' },
    { value: LOCAL_VALUE, label: 'Local only' },
  ];
  const providers = catalog?.cloud ?? [];
  if (providers.length) options.push({ value: 'cloud', label: 'Any cloud' });
  for (const row of providers) {
    const name = providerLabel(row.provider);
    options.push({ value: `cloud:${row.provider}`, label: `${name} (default models)` });
    for (const model of row.models) {
      options.push({ value: `cloud:${row.provider}:${model}`, label: `${name}: ${shortModel(model)}` });
    }
    for (const model of row.disabled ?? []) {
      options.push({ value: `cloud:${row.provider}:${model}`, label: `${name}: ${shortModel(model)} (off)`, disabled: true });
    }
  }
  return options;
}

/** An employee's model picker: everything `modelOptions` offers, plus leaving it at the project's own choice. */
export function memberModelOptions(catalog: ModelCatalog | null): ModelOption[] {
  return [{ value: '', label: 'Project default' }, ...modelOptions(catalog)];
}

/** The provider's models, for the optional "Worker model" select. */
export function workerOptions(catalog: ModelCatalog | null, provider: CloudProvider): ModelOption[] {
  const row = catalog?.cloud.find((c) => c.provider === provider);
  return [
    { value: SAME_AS_ORCHESTRATOR, label: 'Worker: same model' },
    ...(row?.models ?? []).map((model) => ({ value: model, label: `Worker: ${shortModel(model)}` })),
    ...(row?.disabled ?? []).map((model) => ({ value: model, label: `Worker: ${shortModel(model)} (off)`, disabled: true })),
  ];
}

/**
 * The policy an option value stands for. Picking one concrete model sets *both* tiers to it — one
 * select, one decision; the worker select then refines the worker tier on its own.
 */
export function policyFromValue(value: string): ModelPolicy {
  if (value === LOCAL_VALUE) return { prefer: 'local' };
  if (!value.startsWith('cloud')) return { prefer: 'auto' };
  const [, provider, ...rest] = value.split(':');
  if (!provider) return { prefer: 'cloud' };
  const model = rest.join(':');
  return {
    prefer: 'cloud',
    provider: provider as CloudProvider,
    ...(model ? { orchestratorModel: model, workerModel: model } : {}),
  };
}

/** Which option a project's manifest is currently on. */
export function valueFromPolicy(policy: ModelPolicy | undefined): string {
  if (!policy || policy.prefer === 'auto') return AUTO_VALUE;
  if (policy.prefer === 'local') return LOCAL_VALUE;
  if (!policy.provider) return 'cloud';
  // A worker model that differs is the worker select's business; the main select still shows the
  // orchestrator's model, which is the one the owner picked here.
  const model = policy.orchestratorModel;
  return model ? `cloud:${policy.provider}:${model}` : `cloud:${policy.provider}`;
}

/** The pill next to the project's status, and the allocation table's Models column. */
export function policyPillText(policy: ModelPolicy | undefined): string {
  if (!policy || policy.prefer === 'auto') return 'auto';
  if (policy.prefer === 'local') return 'local only';
  if (!policy.provider) return 'cloud';
  const name = providerLabel(policy.provider);
  const { orchestratorModel: orchestrator, workerModel: worker } = policy;
  if (!orchestrator && !worker) return name;
  if (orchestrator && worker && orchestrator !== worker) {
    return `${name}: ${shortModel(orchestrator)} / ${shortModel(worker)}`;
  }
  // Only one tier is overridden — say which, rather than a bare model name that reads as both.
  if (worker && !orchestrator) return `${name}: default / ${shortModel(worker)}`;
  return `${name}: ${shortModel((orchestrator ?? worker)!)}`;
}
