import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  arch TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  last_heartbeat INTEGER NOT NULL
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
  updated_at INTEGER NOT NULL
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
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
