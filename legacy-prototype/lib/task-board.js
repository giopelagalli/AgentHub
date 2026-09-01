// Task Board — CRUD + assignment logic backed by SQLite
// Only RESEARCH and PROJECT boards (no general TASKS)

const db = require('./db');

class TaskBoard {
  constructor(agentManager) {
    this.agentManager = agentManager;
  }

  /** Create a new task */
  create(title, description = '', agentName = null, boardType = 'research') {
    if (agentName && !this.agentManager.get(agentName)) {
      throw new Error(`Agent "${agentName}" not found`);
    }
    const valid = ['research', 'project'];
    if (!valid.includes(boardType)) boardType = 'research';
    return db.createTask(title, description, agentName, boardType);
  }

  /** Get a single task by ID */
  get(id) {
    const task = db.getTask(id);
    if (!task) throw new Error(`Task #${id} not found`);
    return task;
  }

  /** List tasks with optional filters */
  list(filter = {}) {
    return db.listTasks(filter);
  }

  /** Assign a task to an agent */
  assign(taskId, agentName) {
    if (!this.agentManager.get(agentName)) {
      throw new Error(`Agent "${agentName}" not found`);
    }
    return db.updateTask(taskId, { agent_name: agentName, status: 'assigned' });
  }

  /** Update task status */
  updateStatus(taskId, status) {
    const valid = ['open', 'assigned', 'in_progress', 'completed', 'failed'];
    if (!valid.includes(status)) {
      throw new Error(`Invalid status "${status}". Use: ${valid.join(', ')}`);
    }
    return db.updateTask(taskId, { status });
  }

  /** Update task details */
  update(taskId, updates) {
    return db.updateTask(taskId, updates);
  }

  /** Delete a task (and its subtasks) */
  delete(taskId) {
    db.deleteTask(taskId);
  }

  /** Get all tasks for a specific agent */
  getAgentTasks(agentName, boardType = null) {
    const filter = { agent_name: agentName };
    if (boardType) filter.board_type = boardType;
    return db.listTasks(filter);
  }

  /** Get next pending task for an agent */
  getNextTask(agentName) {
    const tasks = this.getAgentTasks(agentName);
    return tasks.find(t => t.status !== 'completed' && t.status !== 'failed') || null;
  }

  /** Get subtasks for a parent task */
  getSubtasks(parentId) {
    return db.getSubtasks(parentId);
  }

  /** Get summary for frontend, filtered by board type */
  getSummary(boardType = null) {
    const filter = boardType ? { board_type: boardType } : {};
    const all = db.listTasks(filter);
    return {
      total: all.length,
      open: all.filter(t => t.status === 'open').length,
      assigned: all.filter(t => t.status === 'assigned').length,
      in_progress: all.filter(t => t.status === 'in_progress').length,
      completed: all.filter(t => t.status === 'completed').length,
      failed: all.filter(t => t.status === 'failed').length,
      tasks: all,
      boardType,
    };
  }

  /** Get summaries for both board types */
  getAllSummaries() {
    return {
      research: this.getSummary('research'),
      project: this.getSummary('project'),
    };
  }
}

module.exports = TaskBoard;
