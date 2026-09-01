// ============================================================
//  Task Board UI — overlay with RESEARCH + PROJECTS tabs
//  (General TASKS board removed — use per-agent tasks instead)
// ============================================================

const TaskBoardUI = (() => {
  let agents = [];
  let summaries = { research: { tasks: [] }, project: { tasks: [] } };
  let activeBoard = 'research';

  const LABELS = { research: 'Research', project: 'Projects' };
  const els = {};

  function init() {
    els.overlay    = document.getElementById('taskBoardOverlay');
    if (!els.overlay) return;  // overlay removed — module is dormant

    els.btnClose   = document.getElementById('btnCloseTaskBoard');
    els.title      = document.getElementById('taskTitle');
    els.agent      = document.getElementById('taskAgent');
    els.btnCreate  = document.getElementById('btnCreateTask');
    els.list       = document.getElementById('taskList');
    els.tabs       = document.getElementById('boardTabs');

    els.btnClose.addEventListener('click', close);
    els.btnCreate.addEventListener('click', createTask);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) close(); });
    els.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') createTask(); });

    els.tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-board]');
      if (tab) { activeBoard = tab.dataset.board; renderTabs(); renderTasks(); }
    });
  }

  function open(boardType) {
    if (!els.overlay) return;
    if (boardType && LABELS[boardType]) activeBoard = boardType;
    updateAgentSelect();
    renderTabs();
    renderTasks();
    els.overlay.classList.remove('hidden');
    els.title.focus();
  }

  function close() { if (els.overlay) els.overlay.classList.add('hidden'); }

  function updateAgents(agentList) { agents = agentList; }

  function updateAgentSelect() {
    const cur = els.agent.value;
    els.agent.innerHTML = '<option value="">Unassigned</option>';
    for (const a of agents) {
      const o = document.createElement('option');
      o.value = a.name; o.textContent = a.name;
      els.agent.appendChild(o);
    }
    els.agent.value = cur || '';
  }

  function updateTasks(sums) {
    if (sums) {
      if (sums.research) summaries.research = sums.research;
      if (sums.project) summaries.project = sums.project;
    }
    renderTabs();
    renderTasks();
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    for (const [key, label] of Object.entries(LABELS)) {
      const n = summaries[key]?.total || 0;
      const btn = document.createElement('button');
      btn.className = `pixel-btn tab-btn${activeBoard === key ? ' active' : ''}`;
      btn.dataset.board = key;
      btn.textContent = `${label} (${n})`;
      els.tabs.appendChild(btn);
    }
  }

  function renderTasks() {
    const tasks = summaries[activeBoard]?.tasks || [];
    if (!tasks.length) {
      els.list.innerHTML = `<div class="task-empty">No ${LABELS[activeBoard].toLowerCase()} yet.</div>`;
      return;
    }
    els.list.innerHTML = '';
    for (const t of tasks) {
      const d = document.createElement('div');
      d.className = 'task-item';
      d.innerHTML = `
        <span class="task-id">#${t.id}</span>
        <span class="task-title">${esc(t.title)}</span>
        <span class="task-status ${t.status}">${t.status.replace('_', ' ')}</span>
        <span class="task-agent">${t.agent_name || '\u2014'}</span>
        <div class="task-actions">
          ${t.status !== 'completed' ? `<button class="pixel-btn small" data-a="done" data-id="${t.id}">Done</button>` : ''}
          <button class="pixel-btn small" data-a="del" data-id="${t.id}">Del</button>
        </div>`;
      d.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const id = Number(b.dataset.id);
          if (b.dataset.a === 'done') patchTask(id, { status: 'completed' });
          if (b.dataset.a === 'del') delTask(id);
        });
      });
      els.list.appendChild(d);
    }
  }

  async function createTask() {
    const title = els.title.value.trim();
    if (!title) return;
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: '',
          agent_name: els.agent.value || null,
          board_type: activeBoard,
        }),
      });
      els.title.value = '';
    } catch (e) { console.error(e); }
  }

  async function patchTask(id, body) {
    try { await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {}
  }

  async function delTask(id) {
    try { await fetch(`/api/tasks/${id}`, { method: 'DELETE' }); } catch {}
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  return { init, open, close, updateAgents, updateTasks };
})();
