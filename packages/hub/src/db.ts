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
  job_types_json TEXT NOT NULL DEFAULT '[]'
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
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

/** Adds `column` to `table` (via `ddl`, e.g. "TEXT NOT NULL DEFAULT '[]'") if it doesn't already exist. */
export function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  ensureColumn(db, 'nodes', 'job_types_json', `TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn(db, 'jobs', 'attempts', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'jobs', 'result_json', `TEXT`);
  ensureColumn(db, 'jobs', 'error', `TEXT`);
  return db;
}
