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
  control_json TEXT
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
  ensureColumn(db, 'jobs', 'attempts', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'jobs', 'result_json', `TEXT`);
  ensureColumn(db, 'jobs', 'error', `TEXT`);
  relaxMessagesAgentId(db);
  ensureColumn(db, 'messages', 'session_id', `INTEGER`);
  ensureColumn(db, 'messages', 'tool_call_json', `TEXT`);
  // Run after the session_id column is guaranteed to exist — on an old DB, this column doesn't exist
  // until the ensureColumn call directly above adds it.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  return db;
}
