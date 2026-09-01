// ============================================================
//  CEO Todo UI — overlay for the CEO Directives board
// ============================================================

const CeoTodoUI = (() => {
  let todos = [];
  let maxProjects = 3;
  const els = {};

  function init() {
    els.overlay     = document.getElementById('ceoTodoOverlay');
    els.btnClose    = document.getElementById('btnCloseCeoTodo');
    els.title       = document.getElementById('ceoTodoTitle');
    els.btnCreate   = document.getElementById('btnCreateCeoTodo');
    els.list        = document.getElementById('ceoTodoList');
    els.maxInput    = document.getElementById('ceoMaxProjects');
    els.btnSaveMax  = document.getElementById('btnSaveMaxProjects');

    if (!els.overlay) return;

    els.btnClose.addEventListener('click', close);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) close(); });
    els.btnCreate.addEventListener('click', createTodo);
    els.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') createTodo(); });
    els.btnSaveMax.addEventListener('click', saveMaxProjects);
  }

  function open() {
    if (!els.overlay) return;
    loadTodos();
    els.maxInput.value = maxProjects;
    els.overlay.classList.remove('hidden');
    els.title.focus();
  }

  function close() {
    if (els.overlay) els.overlay.classList.add('hidden');
  }

  function updateTodos(list) {
    todos = list || [];
    if (els.overlay && !els.overlay.classList.contains('hidden')) {
      renderTodos();
    }
    // Update board count
    Office.setCeoTodoCount(todos.filter(t => t.status !== 'done').length);
  }

  function updateMaxProjects(n) {
    maxProjects = n || 3;
    if (els.maxInput) els.maxInput.value = maxProjects;
  }

  function renderTodos() {
    if (!els.list) return;

    if (todos.length === 0) {
      els.list.innerHTML = '<div class="task-empty">No directives yet. Add tasks for the CEO to organize into teams.</div>';
      return;
    }

    els.list.innerHTML = '';
    for (const t of todos) {
      const d = document.createElement('div');
      d.className = 'task-item ceo-todo-item';

      const statusClass = t.status === 'done' ? 'completed' :
                          t.status === 'in_progress' ? 'in_progress' : 'open';
      const linkedTag = t.team_id ? `<span class="todo-linked">Team #${t.team_id}</span>` : '';

      d.innerHTML = `
        <span class="task-id">#${t.id}</span>
        <span class="task-title">${esc(t.title)}${linkedTag}</span>
        <span class="task-status ${statusClass}">${t.status.replace('_', ' ')}</span>
        <div class="task-actions">
          ${t.status !== 'done' ? `<button class="pixel-btn small" data-a="done" data-id="${t.id}">Done</button>` : ''}
          <button class="pixel-btn small" data-a="del" data-id="${t.id}">Del</button>
        </div>`;

      d.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const id = Number(b.dataset.id);
          if (b.dataset.a === 'done') patchTodo(id, { status: 'done' });
          if (b.dataset.a === 'del') delTodo(id);
        });
      });
      els.list.appendChild(d);
    }
  }

  async function loadTodos() {
    try {
      const res = await fetch('/api/ceo-todos');
      todos = await res.json();
      renderTodos();
    } catch { /* silent */ }
  }

  async function createTodo() {
    const title = els.title.value.trim();
    if (!title) return;
    try {
      await fetch('/api/ceo-todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      els.title.value = '';
    } catch (e) { console.error(e); }
  }

  async function patchTodo(id, body) {
    try {
      await fetch(`/api/ceo-todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {}
  }

  async function delTodo(id) {
    try { await fetch(`/api/ceo-todos/${id}`, { method: 'DELETE' }); } catch {}
  }

  async function saveMaxProjects() {
    const n = Number(els.maxInput.value) || 3;
    try {
      await fetch('/api/settings/max-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxProjects: n }),
      });
    } catch (e) { console.error(e); }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  return { init, open, close, updateTodos, updateMaxProjects };
})();
