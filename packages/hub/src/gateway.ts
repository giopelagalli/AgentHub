import type { ChatMessage, NodeInfo, ServingEndpoint, Tier } from '@agenthub/shared';
import type { NodeRegistry } from './node-registry.js';

export interface PickResult { node: NodeInfo; endpoint: ServingEndpoint; }

export class ModelGateway {
  private active = new Map<string, number>(); // `${node.name}|${tier}|${endpoint.url}` -> active streams

  constructor(private registry: NodeRegistry) {}

  private key(node: NodeInfo, ep: ServingEndpoint): string { return `${node.name}|${ep.tier}|${ep.url}`; }

  pick(tier: Tier): PickResult | null {
    const candidates: { pick: PickResult; active: number }[] = [];
    for (const node of this.registry.online()) {
      for (const endpoint of node.endpoints) {
        if (endpoint.tier !== tier) continue;
        const active = this.active.get(this.key(node, endpoint)) ?? 0;
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

  async chat(tier: Tier, messages: ChatMessage[], onToken?: (t: string) => void): Promise<string> {
    const picked = this.pick(tier);
    if (!picked) throw new Error(`no capacity for tier: ${tier}`);
    const key = this.key(picked.node, picked.endpoint);
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      const res = await fetch(`${picked.endpoint.url}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: picked.endpoint.model, messages, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error(`endpoint error ${res.status} from ${picked.endpoint.url}`);
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
          if (typeof delta === 'string' && delta.length) { full += delta; onToken?.(delta); }
        }
      }
      return full;
    } finally {
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    }
  }
}
