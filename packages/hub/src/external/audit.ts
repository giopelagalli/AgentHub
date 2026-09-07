import type { Db } from '../db.js';

/** How long a purpose line is kept; the audit is a ledger of calls, not a copy of their payloads. */
const PURPOSE_LIMIT = 200;

export interface ToolAuditEntry {
  /** The agent session the call was made from; absent for calls with no session behind them. */
  sessionId?: number;
  /** Tool name as the model sees it (`grok_query`, `web_search`, ...). */
  tool: string;
  /** What the call was for — the prompt, question or query, trimmed. */
  purpose: string;
  requestBytes: number;
  responseBytes: number;
  ok: boolean;
}

export interface ToolAuditRow extends Omit<ToolAuditEntry, 'sessionId'> {
  id: number;
  at: number;
  sessionId: number | null;
}

interface Row {
  id: number; at: number; session_id: number | null; tool: string; purpose: string;
  request_bytes: number; response_bytes: number; ok: number;
}

const toRow = (r: Row): ToolAuditRow => ({
  id: r.id, at: r.at, sessionId: r.session_id, tool: r.tool, purpose: r.purpose,
  requestBytes: r.request_bytes, responseBytes: r.response_bytes, ok: r.ok === 1,
});

/** Default page size of `GET /api/audit`. */
export const AUDIT_DEFAULT_LIMIT = 50;
/** Cap on that page size, so one request can't ask for the whole ledger. */
export const AUDIT_MAX_LIMIT = 500;

/**
 * The per-call ledger of every request that leaves the owner's machines (PRD §12). One row per
 * external tool call, failures included — an attempt that errored is exactly the kind of call the
 * owner wants to see.
 *
 * The table is owned here rather than in `db.ts` so the whole outbound story lives in `external/`.
 */
export class ToolAudit {
  constructor(private db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        session_id INTEGER,
        tool TEXT NOT NULL,
        purpose TEXT NOT NULL,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        ok INTEGER NOT NULL
      );
    `);
  }

  record(entry: ToolAuditEntry, now = Date.now()): ToolAuditRow {
    const purpose = entry.purpose.replace(/\s+/g, ' ').trim().slice(0, PURPOSE_LIMIT);
    const info = this.db.prepare(
      `INSERT INTO tool_audit (at, session_id, tool, purpose, request_bytes, response_bytes, ok) VALUES (?,?,?,?,?,?,?)`,
    ).run(now, entry.sessionId ?? null, entry.tool, purpose, entry.requestBytes, entry.responseBytes, entry.ok ? 1 : 0);
    return {
      id: Number(info.lastInsertRowid), at: now, sessionId: entry.sessionId ?? null,
      tool: entry.tool, purpose, requestBytes: entry.requestBytes, responseBytes: entry.responseBytes, ok: entry.ok,
    };
  }

  /** Newest first — the audit is read as "what just left the machine". */
  list(limit = AUDIT_DEFAULT_LIMIT): ToolAuditRow[] {
    return (this.db.prepare(`SELECT * FROM tool_audit ORDER BY id DESC LIMIT ?`)
      .all(Math.min(Math.max(limit, 1), AUDIT_MAX_LIMIT)) as Row[]).map(toRow);
  }
}

export interface ExternalCall {
  tool: string;
  purpose: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON request body; omitted, the call is sent without one. */
  body?: unknown;
  timeoutMs: number;
  sessionId?: number;
}

/**
 * The one place an external tool reaches the network. Every call is bounded by a timeout, and every
 * outcome — answered, refused or timed out — lands one `tool_audit` row before the result (or the
 * error) goes back to the caller.
 *
 * Bytes are counted on the wire text, not the parsed value: a request with no body is measured by
 * its URL, which is where a GET carries its query.
 */
export async function callExternal(audit: ToolAudit, call: ExternalCall): Promise<unknown> {
  const bodyText = call.body === undefined ? undefined : JSON.stringify(call.body);
  const requestBytes = Buffer.byteLength(bodyText ?? call.url);
  let responseBytes = 0;
  let ok = false;
  try {
    const res = await fetch(call.url, {
      method: call.method ?? (bodyText ? 'POST' : 'GET'),
      headers: { accept: 'application/json', ...(bodyText ? { 'content-type': 'application/json' } : {}), ...call.headers },
      ...(bodyText ? { body: bodyText } : {}),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    const text = await res.text();
    responseBytes = Buffer.byteLength(text);
    if (!res.ok) throw new Error(`${call.tool} failed: HTTP ${res.status}`);
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${call.tool} returned a body that is not JSON`);
    }
    ok = true;
    return parsed;
  } catch (err) {
    // A timeout surfaces as an AbortError/TimeoutError whose message says nothing useful.
    const name = (err as Error).name;
    throw name === 'TimeoutError' || name === 'AbortError'
      ? new Error(`${call.tool} timed out after ${call.timeoutMs}ms`)
      : (err as Error);
  } finally {
    audit.record({
      tool: call.tool, purpose: call.purpose, requestBytes, responseBytes, ok,
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
    });
  }
}
