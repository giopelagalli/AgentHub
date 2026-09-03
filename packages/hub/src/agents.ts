import type { ChatMessage, Tier } from '@agenthub/shared';
import type { Db } from './db.js';
import type { ModelGateway } from './gateway.js';

export interface AgentRecord { id: number; name: string; tier: Tier; systemPrompt: string; }

interface AgentRow { id: number; name: string; tier: Tier; system_prompt: string; }
interface MessageRow { role: 'system' | 'user' | 'assistant'; content: string; }

const toAgent = (r: AgentRow): AgentRecord => ({ id: r.id, name: r.name, tier: r.tier, systemPrompt: r.system_prompt });

export class AgentRuntime {
  constructor(private db: Db, private gateway: ModelGateway) {}

  createAgent(a: { name: string; tier: Tier; systemPrompt: string }): AgentRecord {
    const res = this.db.prepare(`INSERT INTO agents (name, tier, system_prompt) VALUES (?,?,?)`)
      .run(a.name, a.tier, a.systemPrompt);
    return { id: Number(res.lastInsertRowid), ...a };
  }

  getAgent(id: number): AgentRecord | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return r ? toAgent(r) : null;
  }

  listAgents(): AgentRecord[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY id`).all() as AgentRow[]).map(toAgent);
  }

  history(agentId: number): ChatMessage[] {
    return (this.db.prepare(`SELECT role, content FROM messages WHERE agent_id=? ORDER BY id`)
      .all(agentId) as MessageRow[]).map((m) => ({ role: m.role, content: m.content }));
  }

  async send(agentId: number, userText: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
      ...this.history(agentId),
      { role: 'user', content: userText },
    ];
    const result = await this.gateway.chat(agent.tier, messages, { onToken, signal });
    const reply = result.content;
    const insert = this.db.prepare(`INSERT INTO messages (agent_id, role, content, created_at) VALUES (?,?,?,?)`);
    const now = Date.now();
    insert.run(agentId, 'user', userText, now);
    insert.run(agentId, 'assistant', reply, now + 1);
    return reply;
  }
}
