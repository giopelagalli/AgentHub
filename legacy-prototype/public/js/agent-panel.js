// ============================================================
//  Agent Panel — side panel with Chat + Tasks tabs
// ============================================================

const AgentPanel = (() => {
  let currentAgent = null;
  let isStreaming = false;
  let streamEl = null;
  let activeTab = 'chat';
  let activeTaskBoard = 'research';
  let agentTasks = { research: [], project: [] };

  const els = {};

  function init() {
    els.panel        = document.getElementById('panel');
    els.name         = document.getElementById('panelName');
    els.role         = document.getElementById('panelRole');
    els.avatar       = document.getElementById('panelAvatar');
    els.status       = document.getElementById('panelStatus');
    els.llm          = document.getElementById('panelLlm');
    els.model        = document.getElementById('panelModel');
    els.location     = document.getElementById('panelLocation');
    els.messages     = document.getElementById('chatMessages');
    els.input        = document.getElementById('chatInput');
    els.btnSend      = document.getElementById('btnSend');
    els.btnClose     = document.getElementById('btnClosePanel');
    els.btnClear     = document.getElementById('btnClearChat');
    els.panelTabs    = document.getElementById('panelTabs');
    els.chatTab      = document.getElementById('chatTab');
    els.tasksTab     = document.getElementById('tasksTab');
    els.agentTaskTabs = document.getElementById('agentTaskTabs');
    els.agentTaskTitle = document.getElementById('agentTaskTitle');
    els.btnCreateTask  = document.getElementById('btnCreateAgentTask');
    els.agentTaskList  = document.getElementById('agentTaskList');
    els.nextTaskTitle  = document.getElementById('nextTaskTitle');

    els.btnDelete    = document.getElementById('btnDeleteAgent');

    els.btnClose.addEventListener('click', close);
    els.btnSend.addEventListener('click', sendMessage);
    els.btnClear.addEventListener('click', clearChat);
    els.btnDelete.addEventListener('click', deleteAgent);

    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Tab switching
    els.panelTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.panel-tab');
      if (!tab) return;
      activeTab = tab.dataset.tab;
      renderTabs();
    });

    // Task board tabs (research / project)
    els.agentTaskTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-board]');
      if (!btn) return;
      activeTaskBoard = btn.dataset.board;
      renderTaskTabs();
      renderAgentTasks();
    });

    // Create agent task
    els.btnCreateTask.addEventListener('click', createAgentTask);
    els.agentTaskTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createAgentTask();
    });
  }

  function open(agentName, agents) {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) return;

    currentAgent = agent;

    els.name.textContent = agent.name;
    els.role.textContent = agent.role;
    els.llm.textContent = agent.llmType;
    els.model.textContent = agent.llmModel;
    updateStatus(agent.status);
    updateLocation(agentName);

    drawAvatarPreview(agent.avatar);
    loadMessages(agentName);
    loadAgentTasks(agentName);

    // Reset to chat tab
    activeTab = 'chat';
    renderTabs();

    els.panel.classList.remove('hidden');
    els.input.focus();
  }

  function close() {
    els.panel.classList.add('hidden');
    currentAgent = null;
  }

  function isOpen() { return currentAgent !== null; }
  function getCurrentName() { return currentAgent?.name || null; }

  function updateStatus(status) {
    els.status.textContent = status;
    els.status.className = `panel-status ${status}`;
  }

  function updateLocation(agentName) {
    const animState = Office.getAnimState(agentName);
    if (!animState) {
      els.location.textContent = 'At desk';
      return;
    }
    switch (animState.animState) {
      case Office.ANIM.SEATED:
      case Office.ANIM.GETTING_UP:
      case Office.ANIM.SITTING_DOWN:
        els.location.textContent = 'At desk';
        break;
      case Office.ANIM.WALKING:
        els.location.textContent = 'Walking...';
        break;
      case Office.ANIM.AT_LOCATION:
        if (animState.destination) {
          const d = animState.destination;
          if (d.type === 'desk') els.location.textContent = `Visiting ${d.name}`;
          else if (d.type === 'board') els.location.textContent = `At ${d.name} board`;
        } else {
          els.location.textContent = 'Away';
        }
        break;
      default:
        els.location.textContent = 'At desk';
    }
  }

  // ── Tab rendering ─────────────────────────────────────────

  function renderTabs() {
    for (const btn of els.panelTabs.querySelectorAll('.panel-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    }
    els.chatTab.classList.toggle('hidden', activeTab !== 'chat');
    els.tasksTab.classList.toggle('hidden', activeTab !== 'tasks');
  }

  function renderTaskTabs() {
    for (const btn of els.agentTaskTabs.querySelectorAll('[data-board]')) {
      btn.classList.toggle('active', btn.dataset.board === activeTaskBoard);
    }
  }

  // ── Agent task list ───────────────────────────────────────

  async function loadAgentTasks(agentName) {
    try {
      const [resR, resP] = await Promise.all([
        fetch(`/api/tasks?agent=${encodeURIComponent(agentName)}&board=research`),
        fetch(`/api/tasks?agent=${encodeURIComponent(agentName)}&board=project`),
      ]);
      agentTasks.research = await resR.json();
      agentTasks.project = await resP.json();
      renderAgentTasks();
      updateNextTask();
    } catch { /* silent */ }
  }

  function renderAgentTasks() {
    const tasks = agentTasks[activeTaskBoard] || [];
    if (!tasks.length) {
      els.agentTaskList.innerHTML = `<div class="task-empty">No ${activeTaskBoard} tasks.</div>`;
      return;
    }
    els.agentTaskList.innerHTML = '';
    for (const t of tasks) {
      const d = document.createElement('div');
      d.className = 'task-item';
      d.innerHTML = `
        <span class="task-id">#${t.id}</span>
        <span class="task-title">${esc(t.title)}</span>
        <span class="task-status ${t.status}">${t.status.replace('_', ' ')}</span>
        <div class="task-actions">
          ${t.status !== 'completed' ? `<button class="pixel-btn small" data-a="done" data-id="${t.id}">Done</button>` : ''}
          <button class="pixel-btn small" data-a="del" data-id="${t.id}">Del</button>
        </div>`;
      d.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const id = Number(b.dataset.id);
          if (b.dataset.a === 'done') patchAgentTask(id, { status: 'completed' });
          if (b.dataset.a === 'del') delAgentTask(id);
        });
      });
      els.agentTaskList.appendChild(d);
    }
  }

  function updateNextTask() {
    // Find the first non-completed task
    const allTasks = [...(agentTasks.research || []), ...(agentTasks.project || [])];
    const next = allTasks.find(t => t.status !== 'completed' && t.status !== 'failed');
    if (next) {
      const board = agentTasks.research?.includes(next) ? 'Research' : 'Project';
      els.nextTaskTitle.textContent = `[${board}] ${next.title}`;
      els.nextTaskTitle.style.color = 'var(--accent2)';
    } else {
      els.nextTaskTitle.textContent = 'No pending tasks';
      els.nextTaskTitle.style.color = '';
    }
  }

  async function createAgentTask() {
    if (!currentAgent) return;
    const title = els.agentTaskTitle.value.trim();
    if (!title) return;
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: '',
          agent_name: currentAgent.name,
          board_type: activeTaskBoard,
        }),
      });
      els.agentTaskTitle.value = '';
      loadAgentTasks(currentAgent.name);
    } catch (e) { console.error(e); }
  }

  async function patchAgentTask(id, body) {
    try {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (currentAgent) loadAgentTasks(currentAgent.name);
    } catch {}
  }

  async function delAgentTask(id) {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (currentAgent) loadAgentTasks(currentAgent.name);
    } catch {}
  }

  // ── Chat ──────────────────────────────────────────────────

  function drawAvatarPreview(palette) {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size + 4;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;

    const p = Sprites.PALETTES[palette] || Sprites.PALETTES.blue;
    const s = 2;
    const draw = (x, y, color) => { cx.fillStyle = color; cx.fillRect(x * s, y * s, s, s); };

    // Robot head (metal)
    const M = Sprites.C.robotMetal;
    const Md = Sprites.C.robotMetalDk;
    const T = Sprites.C.robotTread;
    const Tr = Sprites.C.robotTreadRim;
    for (let i = 4; i <= 11; i++) draw(i, 1, M);
    for (let i = 3; i <= 12; i++) draw(i, 2, M);
    for (let i = 3; i <= 12; i++) draw(i, 3, M);
    draw(5, 3, p.visor); draw(10, 3, p.visor); // eyes
    for (let i = 3; i <= 12; i++) draw(i, 4, Md);
    // Robot body (colored)
    for (let i = 2; i <= 13; i++) draw(i, 5, p.body);
    for (let i = 2; i <= 13; i++) draw(i, 6, p.body);
    draw(7, 6, p.visor); draw(8, 6, p.visor); // indicators
    for (let i = 2; i <= 13; i++) draw(i, 7, p.body);
    // Central support leg
    for (let i = 6; i <= 9; i++) draw(i, 8, M);
    for (let i = 6; i <= 9; i++) draw(i, 9, Md);
    // Single tread block (4w × 5h centered)
    for (let i = 6; i <= 9; i++) draw(i, 10, Tr);   // top rim
    for (let i = 6; i <= 9; i++) draw(i, 11, T);     // body
    for (let i = 6; i <= 9; i++) draw(i, 12, T);     // body
    for (let i = 6; i <= 9; i++) draw(i, 13, T);     // body
    for (let i = 6; i <= 9; i++) draw(i, 14, Tr);    // bottom rim

    els.avatar.style.background = `url(${c.toDataURL()}) center/cover no-repeat`;
    els.avatar.style.imageRendering = 'pixelated';
  }

  function addMessage(role, content, streaming = false) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.textContent = role === 'user' ? 'You' : currentAgent?.name || 'Agent';
    div.appendChild(roleLabel);

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = content;
    div.appendChild(body);

    if (streaming) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      body.appendChild(cursor);
      streamEl = body;
    }

    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    return body;
  }

  function appendStreamToken(text) {
    if (!streamEl) return;
    const cursor = streamEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    streamEl.textContent += text;
    const c = document.createElement('span');
    c.className = 'cursor';
    streamEl.appendChild(c);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function endStream() {
    if (streamEl) {
      const cursor = streamEl.querySelector('.cursor');
      if (cursor) cursor.remove();
      streamEl = null;
    }
    isStreaming = false;
    els.btnSend.disabled = false;
    els.input.disabled = false;
    els.input.focus();
  }

  function sendMessage() {
    if (isStreaming || !currentAgent) return;
    const text = els.input.value.trim();
    if (!text) return;

    addMessage('user', text);
    els.input.value = '';

    isStreaming = true;
    els.btnSend.disabled = true;
    els.input.disabled = true;
    addMessage('assistant', '', true);

    if (typeof window.sendChatMessage === 'function') {
      window.sendChatMessage(currentAgent.name, text);
    }
  }

  function clearChat() {
    if (!currentAgent) return;
    els.messages.innerHTML = '';
    if (typeof window.clearAgentChat === 'function') {
      window.clearAgentChat(currentAgent.name);
    }
  }

  async function deleteAgent() {
    if (!currentAgent) return;
    const name = currentAgent.name;
    if (!confirm(`Delete agent "${name}"? This removes them from teams and deletes all their data.`)) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        close();
      } else {
        alert(data.error || 'Failed to delete agent');
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadMessages(agentName) {
    els.messages.innerHTML = '';
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/messages`);
      const msgs = await res.json();
      for (const m of msgs) addMessage(m.role, m.content);
    } catch { /* empty chat is fine */ }
  }

  function updateAgent(agents) {
    if (!currentAgent) return;
    const updated = agents.find(a => a.name === currentAgent.name);
    if (updated) {
      currentAgent = updated;
      updateStatus(updated.status);
      updateLocation(updated.name);
    }
  }

  function refreshTasks() {
    if (currentAgent) loadAgentTasks(currentAgent.name);
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  return {
    init, open, close, isOpen, getCurrentName,
    addMessage, appendStreamToken, endStream,
    updateAgent, refreshTasks,
  };
})();
