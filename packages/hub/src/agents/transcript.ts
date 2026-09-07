import type { ChatMessage, Tier, ToolCall } from '@agenthub/shared';
import type { Db } from '../db.js';

export type SessionKind = 'master' | 'orchestrator' | 'subagent' | 'assistant';
export type SessionOutcome = 'stop' | 'budget-exhausted' | 'error' | 'aborted';

export interface SessionRecord {
  id: number;
  kind: SessionKind;
  subject: string;
  tier: Tier;
  startedAt: number;
  endedAt: number | null;
  outcome: SessionOutcome | null;
}

interface SessionRow { id: number; kind: SessionKind; subject: string; tier: Tier; started_at: number; ended_at: number | null; outcome: SessionOutcome | null; }
interface MessageRow { role: ChatMessage['role']; content: string; tool_call_json: string | null; }

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id, kind: r.kind, subject: r.subject, tier: r.tier,
  startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
});

/**
 * Persists agent conversations in the shared `messages` table, keyed by `session_id`.
 *
 * `tool_call_json` carries whatever the plain `role`/`content` columns can't: the assistant's
 * `tool_calls` array, or `{ tool_call_id }` for a tool result. `agent_id` belongs to AgentRuntime's
 * staff-floor agents; session messages have no agent and leave it NULL.
 */
export class Transcript {
  constructor(private db: Db) {}

  startSession(kind: SessionKind, subject: string, tier: Tier, now = Date.now()): number {
    const res = this.db.prepare(`INSERT INTO sessions (kind, subject, tier, started_at) VALUES (?,?,?,?)`)
      .run(kind, subject, tier, now);
    return Number(res.lastInsertRowid);
  }

  append(sessionId: number, msg: ChatMessage, now = Date.now()): void {
    const toolCallJson = msg.role === 'assistant' && msg.tool_calls?.length
      ? JSON.stringify(msg.tool_calls)
      : msg.role === 'tool'
        ? JSON.stringify({ tool_call_id: msg.tool_call_id })
        : null;
    this.db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_json, created_at) VALUES (?,?,?,?,?)`)
      .run(sessionId, msg.role, msg.content ?? '', toolCallJson, now);
  }

  /**
   * Records something that happened *to* the session (a gateway failure, a spent budget) rather than
   * a turn in the conversation. Stored with role `event` so `messages()` — whose output is fed back
   * to a model — never picks it up.
   */
  appendEvent(sessionId: number, content: string, now = Date.now()): void {
    this.db.prepare(`INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'event', ?, ?)`)
      .run(sessionId, content, now);
  }

  events(sessionId: number): { content: string; at: number }[] {
    return this.db.prepare(`SELECT content, created_at AS at FROM messages WHERE session_id=? AND role='event' ORDER BY id`)
      .all(sessionId) as { content: string; at: number }[];
  }

  endSession(id: number, outcome: SessionOutcome, now = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET ended_at=?, outcome=? WHERE id=?`).run(now, outcome, id);
  }

  messages(sessionId: number): ChatMessage[] {
    const rows = this.db.prepare(`SELECT role, content, tool_call_json FROM messages WHERE session_id=? AND role<>'event' ORDER BY id`)
      .all(sessionId) as MessageRow[];
    return rows.map((r): ChatMessage => {
      if (r.role === 'assistant') {
        const toolCalls = r.tool_call_json ? (JSON.parse(r.tool_call_json) as ToolCall[]) : undefined;
        return { role: 'assistant', content: r.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
      }
      if (r.role === 'tool') {
        const { tool_call_id } = JSON.parse(r.tool_call_json ?? '{}') as { tool_call_id?: string };
        return { role: 'tool', tool_call_id: tool_call_id ?? '', content: r.content };
      }
      return { role: r.role, content: r.content };
    });
  }

  /**
   * `limit`, when given, fetches the `limit` most recent sessions (newest-first at the SQL level,
   * cheaper than scanning the whole table) and hands them back oldest-first — same order as the
   * unlimited call — so every caller can keep reading this as a plain chronological list.
   */
  sessions(filter: { kind?: SessionKind; subject?: string; limit?: number } = {}): SessionRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind) { where.push('kind=?'); params.push(filter.kind); }
    if (filter.subject) { where.push('subject=?'); params.push(filter.subject); }
    const order = filter.limit ? 'DESC' : 'ASC';
    let sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${order}`;
    if (filter.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
    const rows = (this.db.prepare(sql).all(...params) as SessionRow[]).map(toSession);
    return filter.limit ? rows.reverse() : rows;
  }
}
