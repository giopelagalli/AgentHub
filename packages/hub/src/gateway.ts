import type { ChatMessage, ChatResult, CloudProvider, ModelPolicy, NodeInfo, ServingEndpoint, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import type { NodeRegistry } from './node-registry.js';
import { anthropicChat, isRetryableAnthropicError, type AnthropicLike } from './providers/anthropic.js';

export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }

/**
 * One caller's model preference for one request — a project's `modelPolicy` resolved for the tier
 * it is about to use (`routeFor`). Absent, the gateway behaves exactly as it did before: local
 * endpoints first, cloud as overflow.
 */
export interface Route {
  prefer?: ModelPolicy['prefer'];
  provider?: CloudProvider;
  /** Overrides the chosen endpoint's model — only ever on a cloud endpoint of `provider`. */
  model?: string;
}

export interface ChatOptions { onToken?: (t: string) => void; tools?: ToolDef[]; signal?: AbortSignal; route?: Route }

const UNHEALTHY_MS = 10_000;

/** Anything not spoken over a local OpenAI-compatible endpoint — the Anthropic and Fireworks tiers. */
export const isCloudEndpoint = (ep: ServingEndpoint): boolean => (ep.provider ?? 'openai') !== 'openai';

/** The tier-specific slice of a project's policy, or undefined when it has none (i.e. `auto`). */
export function routeFor(policy: ModelPolicy | undefined, tier: Tier): Route | undefined {
  if (!policy) return undefined;
  const model = tier === 'orchestrator' ? policy.orchestratorModel : policy.workerModel;
  return {
    prefer: policy.prefer,
    ...(policy.provider ? { provider: policy.provider } : {}),
    ...(model ? { model } : {}),
  };
}

/** Whether `route.model` may replace `ep`'s own model: cloud only, and the asked-for provider only. */
function modelOverrideApplies(ep: ServingEndpoint, route: Route | undefined): boolean {
  if (!route?.model || !isCloudEndpoint(ep)) return false;
  return !route.provider || ep.provider === route.provider;
}

export class ModelGateway {
  private active = new Map<string, number>(); // `${node.name}|${tier}|${endpoint.url}` -> active streams
  private unhealthyUntil = new Map<string, number>(); // same key -> epoch ms until which it's skipped
  // Endpoints parked by the ResourceManager for the Spark exclusivity swap (spec §4.3). Unlike
  // `unhealthyUntil` this has no expiry: the endpoint's serving process is actually stopped, and
  // only the manager that parked it knows when it is back.
  private parked = new Set<string>();
  /** `apiKeyEnv` names already reported missing, so an unset key costs one log line, not one per pick. */
  private missingKeysLogged = new Set<string>();
  private now: () => number;
  /** Serves every `provider: 'anthropic'` endpoint; absent when no cloud tier is configured. */
  private anthropic: AnthropicLike | undefined;

  constructor(private registry: NodeRegistry, opts: { now?: () => number; anthropic?: AnthropicLike } = {}) {
    this.now = opts.now ?? Date.now;
    this.anthropic = opts.anthropic;
  }

  private key(node: NodeInfo, ep: ServingEndpoint): string { return `${node.name}|${ep.tier}|${ep.url}`; }

  private markUnhealthy(key: string): void {
    this.unhealthyUntil.set(key, this.now() + UNHEALTHY_MS);
  }

  /**
   * The bearer token `ep` needs, or null when it names an env var the process doesn't have — which
   * takes the endpoint out of rotation rather than sending an unauthenticated request. Endpoints
   * without `apiKeyEnv` need no token and return undefined.
   */
  private bearer(ep: ServingEndpoint): string | null | undefined {
    if (!ep.apiKeyEnv) return undefined;
    const value = process.env[ep.apiKeyEnv];
    if (value) return value;
    if (!this.missingKeysLogged.has(ep.apiKeyEnv)) {
      this.missingKeysLogged.add(ep.apiKeyEnv);
      console.warn(`[gateway] ${ep.apiKeyEnv} is not set; ${ep.url} is unavailable`);
    }
    return null;
  }

  /**
   * Every endpoint that could serve `tier` right now under `route`: online, not parked, not marked
   * unhealthy, and with the token it needs. Capacity is *not* checked here — `pick` adds that, while
   * `hasOtherHealthyCandidate` deliberately ignores it.
   */
  private eligible(tier: Tier, route?: Route): { node: NodeInfo; endpoint: ServingEndpoint; key: string }[] {
    const now = this.now();
    // `prefer: 'local'` means local only — the cloud is a fallback for a tier nothing local serves
    // at all, not overflow for a local endpoint that happens to be busy or briefly unhealthy.
    const localOnly = route?.prefer === 'local' && this.hasLocalEndpoint(tier);
    const out: { node: NodeInfo; endpoint: ServingEndpoint; key: string }[] = [];
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) {
        if (endpoint.tier !== tier) continue;
        if (localOnly && isCloudEndpoint(endpoint)) continue;
        const key = this.key(node, endpoint);
        if (this.parked.has(key)) continue;
        const until = this.unhealthyUntil.get(key);
        if (until !== undefined && until > now) continue;
        if (this.bearer(endpoint) === null) continue;
        out.push({ node, endpoint, key });
      }
    }
    return out;
  }

  /** Whether any online node serves `tier` locally at all — busy, unhealthy or parked included. */
  private hasLocalEndpoint(tier: Tier): boolean {
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) if (endpoint.tier === tier && !isCloudEndpoint(endpoint)) return true;
    }
    return false;
  }

  /** Lower sorts first: the group `route` asks for, then the rest. */
  private rank(ep: ServingEndpoint, route?: Route): number {
    const cloud = isCloudEndpoint(ep);
    if (route?.prefer !== 'cloud') return cloud ? 1 : 0; // 'auto' and 'local': local first
    if (cloud && (!route.provider || ep.provider === route.provider)) return 0;
    return cloud ? 2 : 1; // a local endpoint is a better fallback than the wrong cloud
  }

  // Whether some endpoint other than `excludeKey` could currently serve `tier` (i.e. registered,
  // online, and not itself already marked unhealthy). Used to decide whether it's safe to blacklist
  // a failing endpoint: doing so when it's the sole candidate would black out the tier entirely.
  private hasOtherHealthyCandidate(tier: Tier, excludeKey: string, route?: Route): boolean {
    return this.eligible(tier, route).some((c) => c.key !== excludeKey);
  }

  health(): Record<string, number> {
    return Object.fromEntries(this.unhealthyUntil);
  }

  pick(tier: Tier, route?: Route): PickResult | null {
    const candidates = this.eligible(tier, route)
      .map((c) => ({ pick: { node: c.node, endpoint: c.endpoint }, active: this.active.get(c.key) ?? 0, rank: this.rank(c.endpoint, route) }))
      .filter((c) => c.active < c.pick.endpoint.maxStreams);
    // Hardware the owner already paid for comes first unless the route says otherwise; within a
    // group the least busy endpoint wins, as before.
    candidates.sort((a, b) => (a.rank === b.rank ? a.active - b.active : a.rank - b.rank));
    return candidates[0]?.pick ?? null;
  }

  /**
   * Takes every `tiers` endpoint of `nodeName` out of `pick()` until `unpark`. Streams already
   * running on them are not touched — the caller drains them (see `ResourceManager`).
   */
  park(nodeName: string, tiers: Tier[]): void {
    const node = this.registry.byName(nodeName);
    if (!node) return;
    for (const ep of node.endpoints) if (tiers.includes(ep.tier)) this.parked.add(this.key(node, ep));
  }

  /** Puts `nodeName`'s parked endpoints back in rotation. Safe to call when nothing is parked. */
  unpark(nodeName: string): void {
    for (const key of this.parked) if (key.startsWith(`${nodeName}|`)) this.parked.delete(key);
  }

  parkedKeys(): string[] {
    return [...this.parked];
  }

  /** Streams still in flight on `nodeName`'s `tiers` endpoints — what a drain waits to reach 0. */
  activeStreamsOn(nodeName: string, tiers: Tier[]): number {
    let sum = 0;
    for (const [key, n] of this.active) {
      const [name, tier] = key.split('|');
      if (name === nodeName && tiers.includes(tier as Tier)) sum += n;
    }
    return sum;
  }

  activeStreams(tier?: Tier): number {
    let sum = 0;
    for (const [key, n] of this.active) if (!tier || key.split('|')[1] === tier) sum += n;
    return sum;
  }

  chat(tier: Tier, messages: ChatMessage[], onToken?: (t: string) => void, signal?: AbortSignal): Promise<string>;
  chat(tier: Tier, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  async chat(
    tier: Tier,
    messages: ChatMessage[],
    arg3?: ((t: string) => void) | ChatOptions,
    arg4?: AbortSignal,
  ): Promise<string | ChatResult> {
    const legacy = typeof arg3 !== 'object' || arg3 === null;
    const opts: ChatOptions = legacy ? { onToken: arg3 as ((t: string) => void) | undefined, signal: arg4 } : arg3;
    const result = await this.chatInternal(tier, messages, opts);
    return legacy ? result.content : result;
  }

  private async chatInternal(tier: Tier, messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const { onToken, tools, signal, route } = opts;
    for (let attempt = 0; ; attempt++) {
      const picked = this.pick(tier, route);
      if (!picked) throw new Error(`no capacity for tier: ${tier}`);
      const key = this.key(picked.node, picked.endpoint);
      // A project that named a model gets it, but only on the cloud it named: a local endpoint
      // serves whatever its node loaded, and asking it for another model would just 404.
      const model = modelOverrideApplies(picked.endpoint, route) ? route!.model! : picked.endpoint.model;
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      let streamedAny = false;
      let nonRetryable = false;
      try {
        if (picked.endpoint.provider === 'anthropic') {
          if (!this.anthropic) { nonRetryable = true; throw new Error(`no anthropic client configured for ${picked.endpoint.url}`); }
          try {
            return await anthropicChat(this.anthropic, {
              model, messages,
              ...(tools ? { tools } : {}),
              onToken: (t) => { streamedAny = true; onToken?.(t); },
              ...(signal ? { signal } : {}),
            });
          } catch (err) {
            if (!isRetryableAnthropicError(err)) nonRetryable = true;
            throw err;
          }
        }
        // Everything else — local endpoints and Fireworks alike — is OpenAI-compatible HTTP; the
        // only difference is the bearer a remote one needs.
        const token = this.bearer(picked.endpoint);
        if (token === null) { nonRetryable = true; throw new Error(`missing ${picked.endpoint.apiKeyEnv} for ${picked.endpoint.url}`); }
        const res = await fetch(`${picked.endpoint.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ model, messages, stream: true, ...(tools ? { tools } : {}) }),
          signal,
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          // 429 is the cloud saying "later", not "never": retryable like the Anthropic path's.
          if (res.status < 500 && res.status !== 429) nonRetryable = true;
          throw new Error(`endpoint error ${res.status} from ${picked.endpoint.url}`);
        }
        if (!res.body) { nonRetryable = true; throw new Error(`endpoint error ${res.status} from ${picked.endpoint.url}`); }
        let full = '';
        let buf = '';
        let finish: ChatResult['finish'] = 'stop';
        const toolCallAcc = new Map<number, { id?: string; name?: string; arguments: string }>();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            const choice = JSON.parse(data).choices?.[0];
            const delta = choice?.delta;
            if (typeof delta?.content === 'string' && delta.content.length) {
              full += delta.content; streamedAny = true; onToken?.(delta.content);
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const frag of delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
                const i = frag.index ?? 0;
                const acc = toolCallAcc.get(i) ?? { arguments: '' };
                if (frag.id) acc.id = frag.id;
                if (frag.function?.name) acc.name = frag.function.name;
                if (typeof frag.function?.arguments === 'string') acc.arguments += frag.function.arguments;
                toolCallAcc.set(i, acc);
                streamedAny = true;
              }
            }
            if (choice?.finish_reason === 'tool_calls') finish = 'tool_calls';
            else if (choice?.finish_reason === 'length') finish = 'length';
          }
        }
        const toolCalls: ToolCall[] = [...toolCallAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => ({ id: v.id ?? '', name: v.name ?? '', arguments: v.arguments }));
        return { content: full, toolCalls, finish };
      } catch (err) {
        const aborted = signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        if (attempt === 0 && !streamedAny && !nonRetryable && !aborted && this.hasOtherHealthyCandidate(tier, key, route)) {
          this.markUnhealthy(key);
          continue;
        }
        throw err;
      } finally {
        this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
      }
    }
  }
}
