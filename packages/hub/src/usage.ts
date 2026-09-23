import type { ChatUsage, UsageSummary } from '@agenthub/shared';
import type { Db } from './db.js';

/**
 * The hub's cost ledger: one row per model request the gateway served.
 *
 * Every model call in the system goes through `AgentLoop`, which reports here — so the ledger is
 * the single answer to "what has this cost", for the owner's summaries and for the daily cap alike.
 * A row is recorded even when the model has no price: tokens are facts, dollars are a lookup, and
 * an unpriced model must not disappear from the accounting.
 */

/** What the local (`openai`) provider is called in the ledger; its rows always cost 0. */
const LOCAL_PROVIDER = 'openai';

/** One request as the ledger stores it: the gateway's `ChatUsage` plus who it was for. */
export interface UsageRow extends ChatUsage {
  /** The project slug, or `owner`/`master` for work that belongs to no project. */
  subject: string;
  sessionId: number | null;
  memberId?: string | null;
  /** `orchestrator` | `subagent` | `assistant` | `chat` | `prd` | `master`. */
  kind: string;
  at?: number;
}

interface TotalsRow { usd: number | null; prompt: number | null; cached: number | null; completion: number | null }
interface GroupRow { key: string; provider: string; usd: number | null; tokens: number | null }

export class UsageStore {
  constructor(private db: Db) {}

  record(row: UsageRow): void {
    this.db.prepare(
      `INSERT INTO usage (at, subject, session_id, member_id, kind, provider, node, model,
         prompt_tokens, cached_tokens, completion_tokens, usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.at ?? Date.now(), row.subject, row.sessionId, row.memberId ?? null, row.kind,
      row.provider, row.node, row.model,
      row.promptTokens, row.cachedTokens, row.completionTokens, row.usd,
    );
  }

  /**
   * What was spent since `since`, in total, per model and per subject. `subject` narrows all three
   * to one project. Dollars sum over the rows that have a price; an unpriced row still contributes
   * its tokens, which is why the two are counted separately.
   */
  summary(filter: { since: number; subject?: string }): UsageSummary {
    const where = `at >= ?${filter.subject ? ' AND subject = ?' : ''}`;
    const params: (string | number)[] = filter.subject ? [filter.since, filter.subject] : [filter.since];

    const totals = this.db.prepare(
      `SELECT SUM(usd) AS usd, SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached,
              SUM(completion_tokens) AS completion FROM usage WHERE ${where}`,
    ).get(...params) as TotalsRow | undefined;

    const byModel = this.db.prepare(
      `SELECT model AS key, provider, SUM(usd) AS usd, SUM(prompt_tokens + completion_tokens) AS tokens
       FROM usage WHERE ${where} GROUP BY provider, model ORDER BY tokens DESC`,
    ).all(...params) as GroupRow[];

    const bySubject = this.db.prepare(
      `SELECT subject AS key, '' AS provider, SUM(usd) AS usd, SUM(prompt_tokens + completion_tokens) AS tokens
       FROM usage WHERE ${where} GROUP BY subject ORDER BY tokens DESC`,
    ).all(...params) as GroupRow[];

    return {
      since: filter.since,
      usd: totals?.usd ?? 0,
      tokens: {
        prompt: totals?.prompt ?? 0,
        cached: totals?.cached ?? 0,
        completion: totals?.completion ?? 0,
      },
      byModel: byModel.map((r) => ({ provider: r.provider, model: r.key, usd: r.usd ?? 0, tokens: r.tokens ?? 0 })),
      bySubject: bySubject.map((r) => ({ subject: r.key, usd: r.usd ?? 0, tokens: r.tokens ?? 0 })),
    };
  }

  /**
   * What the cloud has cost since `since` — the number the daily cap is compared against. Local
   * rows are excluded rather than relied on to be 0, so a priced local endpoint could never eat the
   * cloud budget; a row with no price contributes nothing, because SUM skips NULL.
   */
  cloudUsdSince(since: number): number {
    const row = this.db.prepare(
      `SELECT SUM(usd) AS usd FROM usage WHERE at >= ? AND provider <> ?`,
    ).get(since, LOCAL_PROVIDER) as { usd: number | null } | undefined;
    return row?.usd ?? 0;
  }
}
