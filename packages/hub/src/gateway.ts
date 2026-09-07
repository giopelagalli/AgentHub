import type { ChatMessage, ChatResult, NodeInfo, ServingEndpoint, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import type { NodeRegistry } from './node-registry.js';

export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }

export interface ChatOptions { onToken?: (t: string) => void; tools?: ToolDef[]; signal?: AbortSignal; }

const UNHEALTHY_MS = 10_000;

export class ModelGateway {
  private active = new Map<string, number>(); // `${node.name}|${tier}|${endpoint.url}` -> active streams
  private unhealthyUntil = new Map<string, number>(); // same key -> epoch ms until which it's skipped
  // Endpoints parked by the ResourceManager for the Spark exclusivity swap (spec §4.3). Unlike
  // `unhealthyUntil` this has no expiry: the endpoint's serving process is actually stopped, and
  // only the manager that parked it knows when it is back.
  private parked = new Set<string>();
  private now: () => number;

  constructor(private registry: NodeRegistry, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private key(node: NodeInfo, ep: ServingEndpoint): string { return `${node.name}|${ep.tier}|${ep.url}`; }

  private markUnhealthy(key: string): void {
    this.unhealthyUntil.set(key, this.now() + UNHEALTHY_MS);
  }

  // Whether some endpoint other than `excludeKey` could currently serve `tier` (i.e. registered,
  // online, and not itself already marked unhealthy). Used to decide whether it's safe to blacklist
  // a failing endpoint: doing so when it's the sole candidate would black out the tier entirely.
  private hasOtherHealthyCandidate(tier: Tier, excludeKey: string): boolean {
    const now = this.now();
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) {
        if (endpoint.tier !== tier) continue;
        const key = this.key(node, endpoint);
        if (key === excludeKey || this.parked.has(key)) continue;
        const until = this.unhealthyUntil.get(key);
        if (until !== undefined && until > now) continue;
        return true;
      }
    }
    return false;
  }

  health(): Record<string, number> {
    return Object.fromEntries(this.unhealthyUntil);
  }

  pick(tier: Tier): PickResult | null {
    const now = this.now();
    const candidates: { pick: PickResult; active: number }[] = [];
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) {
        if (endpoint.tier !== tier) continue;
        const key = this.key(node, endpoint);
        if (this.parked.has(key)) continue;
        const until = this.unhealthyUntil.get(key);
        if (until !== undefined && until > now) continue;
        const active = this.active.get(key) ?? 0;
        if (active < endpoint.maxStreams) candidates.push({ pick: { node, endpoint }, active });
      }
    }
    candidates.sort((a, b) => a.active - b.active);
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
    const { onToken, tools, signal } = opts;
    for (let attempt = 0; ; attempt++) {
      const picked = this.pick(tier);
      if (!picked) throw new Error(`no capacity for tier: ${tier}`);
      const key = this.key(picked.node, picked.endpoint);
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      let streamedAny = false;
      let nonRetryable = false;
      try {
        const res = await fetch(`${picked.endpoint.url}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: picked.endpoint.model, messages, stream: true, ...(tools ? { tools } : {}) }),
          signal,
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          if (res.status < 500) nonRetryable = true;
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
        if (attempt === 0 && !streamedAny && !nonRetryable && !aborted && this.hasOtherHealthyCandidate(tier, key)) {
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
