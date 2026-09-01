// SQLite database — tasks + chat messages + progress

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'agenthub.db');

let db;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Schema ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      status      TEXT    DEFAULT 'open',        -- open | assigned | in_progress | completed | failed
      board_type  TEXT    DEFAULT 'research',     -- research | project
      agent_name  TEXT    DEFAULT NULL,
      progress    REAL    DEFAULT 0,              -- 0.0 to 1.0
      priority    INTEGER DEFAULT 0,              -- higher = more important
      parent_id   INTEGER DEFAULT NULL,           -- for subtasks
      created_at  TEXT    DEFAULT (datetime('now')),
      updated_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name  TEXT    NOT NULL,
      role        TEXT    NOT NULL,               -- user | assistant
      content     TEXT    NOT NULL,
      task_id     INTEGER DEFAULT NULL,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
  `);

  // Migrations for existing DBs
  const migrations = [
    { check: "SELECT board_type FROM tasks LIMIT 1", sql: "ALTER TABLE tasks ADD COLUMN board_type TEXT DEFAULT 'research'" },
    { check: "SELECT progress FROM tasks LIMIT 1", sql: "ALTER TABLE tasks ADD COLUMN progress REAL DEFAULT 0" },
    { check: "SELECT priority FROM tasks LIMIT 1", sql: "ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0" },
    { check: "SELECT parent_id FROM tasks LIMIT 1", sql: "ALTER TABLE tasks ADD COLUMN parent_id INTEGER DEFAULT NULL" },
  ];

  for (const m of migrations) {
    try { db.prepare(m.check).get(); }
    catch {
      db.exec(m.sql);
      console.log(`[DB] Migration applied: ${m.sql.substring(0, 60)}...`);
    }
  }

  // Migrate old 'task' board_type to 'research' (since TASKS board is removed)
  try {
    db.prepare("UPDATE tasks SET board_type = 'research' WHERE board_type = 'task'").run();
  } catch { /* ignore */ }

  // ── Teams + Meetings ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      type        TEXT    DEFAULT 'research',     -- research | production
      color       TEXT    DEFAULT '#44aaff',
      description TEXT    DEFAULT '',
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER NOT NULL,
      agent_name  TEXT    NOT NULL,
      role_in_team TEXT   DEFAULT 'member',
      FOREIGN KEY (team_id) REFERENCES teams(id),
      UNIQUE(team_id, agent_name)
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER DEFAULT NULL,           -- null = all-hands
      title       TEXT    NOT NULL,
      status      TEXT    DEFAULT 'active',        -- active | ended
      started_at  TEXT    DEFAULT (datetime('now')),
      ended_at    TEXT    DEFAULT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS meeting_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  INTEGER NOT NULL,
      agent_name  TEXT    DEFAULT NULL,
      content     TEXT    NOT NULL,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    );

    CREATE TABLE IF NOT EXISTS ceo_todos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      status      TEXT    DEFAULT 'open',        -- open | in_progress | done
      team_id     INTEGER DEFAULT NULL,          -- linked team created for this todo
      priority    INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `);

  // Team description migration (for existing DBs)
  const teamMigrations = [
    { check: "SELECT description FROM teams LIMIT 1", sql: "ALTER TABLE teams ADD COLUMN description TEXT DEFAULT ''" },
  ];
  for (const m of teamMigrations) {
    try { db.prepare(m.check).get(); }
    catch {
      db.exec(m.sql);
      console.log(`[DB] Migration applied: ${m.sql.substring(0, 60)}...`);
    }
  }

  return db;
}

// ── Task helpers ──────────────────────────────────────────────

function createTask(title, description = '', agentName = null, boardType = 'research') {
  const d = getDb();
  const valid = ['research', 'project'];
  if (!valid.includes(boardType)) boardType = 'research';
  const status = agentName ? 'assigned' : 'open';
  const info = d.prepare(
    'INSERT INTO tasks (title, description, status, agent_name, board_type) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description, status, agentName, boardType);
  return getTask(info.lastInsertRowid);
}

function getTask(id) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function listTasks(filter = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter.board_type) {
    sql += ' AND board_type = ?';
    params.push(filter.board_type);
  }
  if (filter.agent_name) {
    sql += ' AND agent_name = ?';
    params.push(filter.agent_name);
  }
  if (filter.parent_id !== undefined) {
    if (filter.parent_id === null) {
      sql += ' AND parent_id IS NULL';
    } else {
      sql += ' AND parent_id = ?';
      params.push(filter.parent_id);
    }
  }

  sql += ' ORDER BY priority DESC, created_at DESC';
  return d.prepare(sql).all(...params);
}

function updateTask(id, updates) {
  const d = getDb();
  const allowed = ['title', 'description', 'status', 'agent_name', 'progress', 'priority', 'parent_id', 'board_type'];
  const sets = [];
  const params = [];

  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }

  if (sets.length === 0) return getTask(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  d.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTask(id);
}

function deleteTask(id) {
  const d = getDb();
  // Delete subtasks first
  d.prepare('DELETE FROM tasks WHERE parent_id = ?').run(id);
  d.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// Get subtasks for a parent task
function getSubtasks(parentId) {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, created_at ASC')
    .all(parentId);
}

// ── Message helpers ───────────────────────────────────────────

function addMessage(agentName, role, content, taskId = null) {
  const d = getDb();
  const info = d.prepare(
    'INSERT INTO messages (agent_name, role, content, task_id) VALUES (?, ?, ?, ?)'
  ).run(agentName, role, content, taskId);
  return d.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

function getMessages(agentName, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM messages WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentName, limit)
    .reverse();
}

function getMessagesByTask(taskId) {
  return getDb()
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId);
}

function clearMessages(agentName) {
  getDb().prepare('DELETE FROM messages WHERE agent_name = ?').run(agentName);
}

// ── Team helpers ──────────────────────────────────────────────

function createTeam(name, type = 'research', color = '#44aaff', description = '') {
  const d = getDb();
  const valid = ['research', 'production'];
  if (!valid.includes(type)) type = 'research';
  const info = d.prepare(
    'INSERT INTO teams (name, type, color, description) VALUES (?, ?, ?, ?)'
  ).run(name, type, color, description);
  return d.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);
}

function getTeam(id) {
  return getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id);
}

function getTeamByName(name) {
  return getDb().prepare('SELECT * FROM teams WHERE name = ?').get(name);
}

function listTeams() {
  return getDb().prepare('SELECT * FROM teams ORDER BY created_at ASC').all();
}

function updateTeam(id, updates) {
  const d = getDb();
  const allowed = ['name', 'type', 'color', 'description'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (sets.length === 0) return getTeam(id);
  params.push(id);
  d.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTeam(id);
}

function deleteTeam(id) {
  const d = getDb();
  // Delete meeting notes for all meetings of this team
  const meetings = d.prepare('SELECT id FROM meetings WHERE team_id = ?').all(id);
  for (const m of meetings) {
    d.prepare('DELETE FROM meeting_notes WHERE meeting_id = ?').run(m.id);
  }
  d.prepare('DELETE FROM meetings WHERE team_id = ?').run(id);
  d.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
  d.prepare('DELETE FROM teams WHERE id = ?').run(id);
}

// ── Team member helpers ──────────────────────────────────────

function addTeamMember(teamId, agentName, roleInTeam = 'member') {
  const d = getDb();
  try {
    d.prepare(
      'INSERT INTO team_members (team_id, agent_name, role_in_team) VALUES (?, ?, ?)'
    ).run(teamId, agentName, roleInTeam);
  } catch (err) {
    // UNIQUE constraint — already a member, update role
    if (err.message.includes('UNIQUE')) {
      d.prepare(
        'UPDATE team_members SET role_in_team = ? WHERE team_id = ? AND agent_name = ?'
      ).run(roleInTeam, teamId, agentName);
    } else throw err;
  }
  return getTeamMembers(teamId);
}

function removeTeamMember(teamId, agentName) {
  getDb().prepare(
    'DELETE FROM team_members WHERE team_id = ? AND agent_name = ?'
  ).run(teamId, agentName);
}

function getTeamMembers(teamId) {
  return getDb().prepare(
    'SELECT * FROM team_members WHERE team_id = ? ORDER BY role_in_team ASC'
  ).all(teamId);
}

function getAgentTeams(agentName) {
  return getDb().prepare(
    `SELECT t.*, tm.role_in_team FROM teams t
     JOIN team_members tm ON t.id = tm.team_id
     WHERE tm.agent_name = ?`
  ).all(agentName);
}

// ── Meeting helpers ──────────────────────────────────────────

function createMeeting(teamId, title) {
  const d = getDb();
  const info = d.prepare(
    'INSERT INTO meetings (team_id, title) VALUES (?, ?)'
  ).run(teamId, title);
  return d.prepare('SELECT * FROM meetings WHERE id = ?').get(info.lastInsertRowid);
}

function endMeeting(id) {
  const d = getDb();
  d.prepare(
    "UPDATE meetings SET status = 'ended', ended_at = datetime('now') WHERE id = ?"
  ).run(id);
  return d.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function getMeeting(id) {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function listMeetings(filter = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM meetings WHERE 1=1';
  const params = [];
  if (filter.team_id !== undefined) {
    sql += ' AND team_id = ?';
    params.push(filter.team_id);
  }
  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY started_at DESC';
  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }
  return d.prepare(sql).all(...params);
}

function getActiveMeeting(teamId) {
  return getDb().prepare(
    "SELECT * FROM meetings WHERE team_id = ? AND status = 'active' LIMIT 1"
  ).get(teamId);
}

// ── Meeting note helpers ─────────────────────────────────────

function addMeetingNote(meetingId, content, agentName = null) {
  const d = getDb();
  const info = d.prepare(
    'INSERT INTO meeting_notes (meeting_id, agent_name, content) VALUES (?, ?, ?)'
  ).run(meetingId, agentName, content);
  return d.prepare('SELECT * FROM meeting_notes WHERE id = ?').get(info.lastInsertRowid);
}

function getMeetingNotes(meetingId) {
  return getDb().prepare(
    'SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at ASC'
  ).all(meetingId);
}

// ── CEO Todo helpers ──────────────────────────────────────────

function createCeoTodo(title, description = '', priority = 0) {
  const d = getDb();
  const info = d.prepare(
    'INSERT INTO ceo_todos (title, description, priority) VALUES (?, ?, ?)'
  ).run(title, description, priority);
  return d.prepare('SELECT * FROM ceo_todos WHERE id = ?').get(info.lastInsertRowid);
}

function getCeoTodo(id) {
  return getDb().prepare('SELECT * FROM ceo_todos WHERE id = ?').get(id);
}

function listCeoTodos(filter = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM ceo_todos WHERE 1=1';
  const params = [];
  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY priority DESC, created_at ASC';
  return d.prepare(sql).all(...params);
}

function updateCeoTodo(id, updates) {
  const d = getDb();
  const allowed = ['title', 'description', 'status', 'team_id', 'priority'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (sets.length === 0) return getCeoTodo(id);
  params.push(id);
  d.prepare(`UPDATE ceo_todos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getCeoTodo(id);
}

function deleteCeoTodo(id) {
  getDb().prepare('DELETE FROM ceo_todos WHERE id = ?').run(id);
}

module.exports = {
  getDb,
  // Tasks
  createTask, getTask, listTasks, updateTask, deleteTask, getSubtasks,
  // Messages
  addMessage, getMessages, getMessagesByTask, clearMessages,
  // Teams
  createTeam, getTeam, getTeamByName, listTeams, updateTeam, deleteTeam,
  // Team members
  addTeamMember, removeTeamMember, getTeamMembers, getAgentTeams,
  // Meetings
  createMeeting, endMeeting, getMeeting, listMeetings, getActiveMeeting,
  // Meeting notes
  addMeetingNote, getMeetingNotes,
  // CEO Todos
  createCeoTodo, getCeoTodo, listCeoTodos, updateCeoTodo, deleteCeoTodo,
};
