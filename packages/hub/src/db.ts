import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  arch TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  last_heartbeat INTEGER NOT NULL,
  job_types_json TEXT NOT NULL DEFAULT '[]',
  browser_json TEXT,
  profiles_json TEXT NOT NULL DEFAULT '[]',
  video INTEGER NOT NULL DEFAULT 0,
  control_json TEXT,
  control_node INTEGER NOT NULL DEFAULT 0,
  draining INTEGER NOT NULL DEFAULT 0,
  models_paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  tier TEXT NOT NULL,
  priority INTEGER NOT NULL,
  project TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  node_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  system_prompt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER REFERENCES agents(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  tier TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_kind_subject ON sessions(kind, subject, ended_at);
CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_seq ON job_logs(job_id, seq);
-- One row per node whose GPU a video job currently holds (spec §4.3). In-memory state alone would
-- strand a node on its \`video\` profile across a hub restart, with nothing left to release it.
CREATE TABLE IF NOT EXISTS video_slots (
  node_name TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL
);
-- One-time tokens the owner mints from the Cluster page and the installer trades for a per-node
-- bearer (PRD FR-D1). Only the sha256 of the token is stored, so a stolen database hands out
-- nothing: \`used_at\` and \`expires_at\` are what make it single-use and short-lived.
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  suggested_name TEXT
);
-- One row per model request the gateway served: what it cost and who it was for. \`usd\` is NULL for
-- a model the hub has no price for (Anthropic, an unpriced id) — the tokens are still recorded.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  session_id INTEGER,
  member_id TEXT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  node TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  usd REAL
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
-- The user API tokens that open the OpenAI-compatible door (PRD FR-D6). Hashed exactly like node
-- tokens: the plaintext is returned once at mint and never stored. \`kind\` decides the vLLM priority
-- a request through the door is sent with (0020); \`user\` is \`admin\` until accounts land (FR-F1).
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
-- One row per GitHub App installation a member completed from the Connect button. No token: the id
-- names a grant the member made on GitHub (and can revoke there), and every actual token is minted
-- per repository and thrown away. \`user\` is 'admin' today and is the column Phase F's accounts need.
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  user TEXT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_installations_user ON github_installations(user);
`;

/** Adds `column` to `table` (via `ddl`, e.g. "TEXT NOT NULL DEFAULT '[]'") if it doesn't already exist. */
export function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Agent-session messages have no owning agent, so `messages.agent_id` must be nullable. Older
 * databases declared it NOT NULL; SQLite can't relax that in place, so the table is rebuilt once.
 * Runs before the session columns are added, so only the original columns need copying.
 */
function relaxMessagesAgentId(db: Db): void {
  const agentId = (db.pragma('table_info(messages)') as { name: string; notnull: number }[])
    .find((c) => c.name === 'agent_id');
  if (!agentId || agentId.notnull === 0) return;
  // foreign_keys must be toggled outside a transaction (SQLite ignores it inside one), so the pragma
  // brackets the transaction rather than living in it.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER REFERENCES agents(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO messages_new (id, agent_id, role, content, created_at)
          SELECT id, agent_id, role, content, created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  ensureColumn(db, 'nodes', 'job_types_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn(db, 'nodes', 'browser_json', `TEXT`);
  ensureColumn(db, 'nodes', 'profiles_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn(db, 'nodes', 'video', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'nodes', 'control_json', `TEXT`);
  ensureColumn(db, 'nodes', 'control_node', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'nodes', 'draining', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'nodes', 'models_paused', `INTEGER NOT NULL DEFAULT 0`);
  // Ownership and per-node credentials (PRD FR-D1/FR-D5). A node that registered before enrollment
  // existed belongs to the admin, which is what the default backfills.
  ensureColumn(db, 'nodes', 'owner', `TEXT NOT NULL DEFAULT 'admin'`);
  ensureColumn(db, 'nodes', 'token_hash', `TEXT`);
  ensureColumn(db, 'nodes', 'enrolled_at', `INTEGER`);
  ensureColumn(db, 'nodes', 'hardware_json', `TEXT`);
  ensureColumn(db, 'jobs', 'attempts', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'jobs', 'result_json', `TEXT`);
  ensureColumn(db, 'jobs', 'error', `TEXT`);
  relaxMessagesAgentId(db);
  ensureColumn(db, 'messages', 'session_id', `INTEGER`);
  ensureColumn(db, 'messages', 'tool_call_json', `TEXT`);
  // Which roster member ran the session; NULL for the manager (orchestrator) and everything else.
  ensureColumn(db, 'sessions', 'member_id', `TEXT`);
  // Run after the session_id column is guaranteed to exist — on an old DB, this column doesn't exist
  // until the ensureColumn call directly above adds it.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  return db;
}
