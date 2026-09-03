import type { ChatMessage, NodeInfo, ServingEndpoint, Tier } from '@agenthub/shared';
import type { NodeRegistry } from './node-registry.js';

export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }

const UNHEALTHY_MS = 10_000;

export class ModelGateway {
  private active = new Map<string, number>(); // `${node.name}|${tier}|${endpoint.url}` -> active streams
  private unhealthyUntil = new Map<string, number>(); // same key -> epoch ms until which it's skipped
  private now: () => number;

  constructor(private registry: NodeRegistry, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private key(node: NodeInfo, ep: ServingEndpoint): string { return `${node.name}|${ep.tier}|${ep.url}`; }

  private markUnhealthy(key: string): void {
    this.unhealthyUntil.set(key, this.now() + UNHEALTHY_MS);
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
        const until = this.unhealthyUntil.get(key);
        if (until !== undefined && until > now) continue;
        const active = this.active.get(key) ?? 0;
        if (active < endpoint.maxStreams) candidates.push({ pick: { node, endpoint }, active });
      }
    }
    candidates.sort((a, b) => a.active - b.active);
    return candidates[0]?.pick ?? null;
  }

  activeStreams(tier?: Tier): number {
    let sum = 0;
    for (const [key, n] of this.active) if (!tier || key.split('|')[1] === tier) sum += n;
    return sum;
  }

  async chat(tier: Tier, messages: ChatMessage[], onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
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
          body: JSON.stringify({ model: picked.endpoint.model, messages, stream: true }),
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
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length) { full += delta; streamedAny = true; onToken?.(delta); }
          }
        }
        return full;
      } catch (err) {
        const aborted = signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        if (attempt === 0 && !streamedAny && !nonRetryable && !aborted) {
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
