// ============================================================
//  Team Panel — overlay when clicking a team enclosure
//  Shows team info, members (add/remove), tasks, meetings
// ============================================================

const TeamPanel = (() => {
  let teams = [];
  let teamMembers = {};     // teamId → [{agent_name, role_in_team}]
  let allAgents = [];       // all agents (for add-member dropdown)
  let currentTeamId = null;
  let teamTasks = [];
  let meetings = [];

  const els = {};

  function init() {
    els.overlay        = document.getElementById('teamPanelOverlay');
    els.btnClose       = document.getElementById('btnCloseTeamPanel');
    els.btnDelete      = document.getElementById('btnDeleteTeam');
    els.name           = document.getElementById('teamPanelName');
    els.type           = document.getElementById('teamPanelType');
    els.descInput      = document.getElementById('teamPanelDescInput');
    els.btnSaveDesc    = document.getElementById('btnSaveTeamDesc');
    els.members        = document.getElementById('teamPanelMembers');
    els.addMemberSel   = document.getElementById('teamAddMemberSelect');
    els.btnAddMember   = document.getElementById('btnAddTeamMember');
    els.taskTitle      = document.getElementById('teamTaskTitle');
    els.taskAgent      = document.getElementById('teamTaskAgent');
    els.btnCreateTask  = document.getElementById('btnCreateTeamTask');
    els.taskList       = document.getElementById('teamTaskList');
    els.meetingActions = document.getElementById('teamMeetingActions');
    els.meetingHistory = document.getElementById('teamMeetingHistory');

    if (!els.overlay) return;

    els.btnClose.addEventListener('click', close);
    els.overlay.addEventListener('click', (e) => {
      if (e.target === els.overlay) close();
    });
    els.btnCreateTask.addEventListener('click', createTask);
    els.taskTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') createTask(); });
    els.btnSaveDesc.addEventListener('click', saveDescription);
    els.btnAddMember.addEventListener('click', addMember);
    els.btnDelete.addEventListener('click', deleteTeam);
  }

  function open(teamId) {
    if (!els.overlay) return;
    currentTeamId = teamId;

    const team = teams.find(t => t.id === teamId);
    if (!team) return;

    const members = teamMembers[teamId] || [];

    els.name.textContent = team.name;
    els.type.textContent = team.type === 'research' ? 'RESEARCH' : 'PROJECT';
    els.type.className = `team-panel-type ${team.type}`;
    els.descInput.value = team.description || '';

    // Members chips with remove buttons
    renderMembers(members);

    // Populate add-member dropdown (agents not already in team)
    updateAddMemberSelect(members);

    // Agent select for tasks
    updateAgentSelect(members);

    // Load tasks and meetings
    loadTeamTasks(teamId, members);
    loadTeamMeetings(teamId);

    // Meeting actions
    renderMeetingActions(team);

    els.overlay.classList.remove('hidden');
  }

  function close() {
    if (els.overlay) els.overlay.classList.add('hidden');
    currentTeamId = null;
  }

  function updateTeams(t, tm) {
    teams = t || [];
    teamMembers = tm || {};
    // Refresh if open
    if (currentTeamId && els.overlay && !els.overlay.classList.contains('hidden')) {
      open(currentTeamId);
    }
  }

  function setAllAgents(agents) {
    allAgents = agents || [];
  }

  // ── Members ───────────────────────────────────────────────

  function renderMembers(members) {
    els.members.innerHTML = '';
    if (members.length === 0) {
      els.members.innerHTML = '<span style="font-size:7px;color:var(--text-dim)">No members yet. Add agents below.</span>';
      return;
    }
    for (const m of members) {
      const chip = document.createElement('span');
      chip.className = 'team-member-chip';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = m.agent_name;
      nameSpan.style.cursor = 'pointer';
      nameSpan.addEventListener('click', () => {
        close();
        if (typeof window.onAgentClick === 'function') {
          window.onAgentClick(m.agent_name);
        }
      });
      chip.appendChild(nameSpan);

      const removeBtn = document.createElement('span');
      removeBtn.className = 'chip-remove';
      removeBtn.textContent = 'x';
      removeBtn.title = `Remove ${m.agent_name} from team`;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeMember(m.agent_name);
      });
      chip.appendChild(removeBtn);

      els.members.appendChild(chip);
    }
  }

  function updateAddMemberSelect(members) {
    const memberNames = new Set(members.map(m => m.agent_name));
    els.addMemberSel.innerHTML = '<option value="">-- pick agent --</option>';
    for (const a of allAgents) {
      if (memberNames.has(a.name)) continue;
      if (a.tier === 'director') continue; // CEO doesn't join teams
      const o = document.createElement('option');
      o.value = a.name;
      o.textContent = `${a.name} (${a.role})`;
      els.addMemberSel.appendChild(o);
    }
  }

  async function addMember() {
    const agentName = els.addMemberSel.value;
    if (!agentName || !currentTeamId) return;
    try {
      await fetch(`/api/teams/${currentTeamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: agentName }),
      });
    } catch (e) { console.error(e); }
  }

  async function removeMember(agentName) {
    if (!currentTeamId) return;
    try {
      await fetch(`/api/teams/${currentTeamId}/members/${encodeURIComponent(agentName)}`, {
        method: 'DELETE',
      });
    } catch (e) { console.error(e); }
  }

  // ── Description ───────────────────────────────────────────

  async function saveDescription() {
    if (!currentTeamId) return;
    const description = els.descInput.value.trim();
    try {
      await fetch(`/api/teams/${currentTeamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
    } catch (e) { console.error(e); }
  }

  // ── Delete team ───────────────────────────────────────────

  async function deleteTeam() {
    if (!currentTeamId) return;
    const team = teams.find(t => t.id === currentTeamId);
    if (!confirm(`Delete team "${team?.name || ''}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/teams/${currentTeamId}`, { method: 'DELETE' });
      close();
    } catch (e) { console.error(e); }
  }

  // ── Agent selects ─────────────────────────────────────────

  function updateAgentSelect(members) {
    els.taskAgent.innerHTML = '<option value="">Unassigned</option>';
    for (const m of members) {
      const o = document.createElement('option');
      o.value = m.agent_name;
      o.textContent = m.agent_name;
      els.taskAgent.appendChild(o);
    }
  }

  // ── Team tasks ────────────────────────────────────────────

  async function loadTeamTasks(teamId, members) {
    if (!els.taskList) return;
    const memberNames = members.map(m => m.agent_name);

    try {
      const allTasks = [];
      for (const name of memberNames) {
        const res = await fetch(`/api/tasks?agent=${encodeURIComponent(name)}`);
        const tasks = await res.json();
        allTasks.push(...tasks);
      }

      const seen = new Set();
      teamTasks = allTasks.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });

      renderTasks();
    } catch { /* silent */ }
  }

  function renderTasks() {
    if (!els.taskList) return;

    if (teamTasks.length === 0) {
      els.taskList.innerHTML = '<div class="task-empty">No team tasks yet.</div>';
      return;
    }

    els.taskList.innerHTML = '';
    for (const t of teamTasks) {
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
        b.addEventListener('click', async () => {
          const id = Number(b.dataset.id);
          if (b.dataset.a === 'done') {
            await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
          }
          if (b.dataset.a === 'del') {
            await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
          }
          const members = teamMembers[currentTeamId] || [];
          loadTeamTasks(currentTeamId, members);
        });
      });
      els.taskList.appendChild(d);
    }
  }

  async function createTask() {
    const title = els.taskTitle.value.trim();
    if (!title || !currentTeamId) return;

    const team = teams.find(t => t.id === currentTeamId);
    const boardType = team?.type === 'production' ? 'project' : 'research';

    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: '',
          agent_name: els.taskAgent.value || null,
          board_type: boardType,
        }),
      });
      els.taskTitle.value = '';
      const members = teamMembers[currentTeamId] || [];
      loadTeamTasks(currentTeamId, members);
    } catch (e) { console.error(e); }
  }

  // ── Team meetings ─────────────────────────────────────────

  function renderMeetingActions(team) {
    if (!els.meetingActions) return;
    els.meetingActions.innerHTML = `
      <button class="pixel-btn small" id="btnCallTeamMeeting">Call Meeting</button>
      <span style="font-size:7px;color:var(--text-dim)">Start a team meeting (cubicles glow)</span>`;

    els.meetingActions.querySelector('#btnCallTeamMeeting').addEventListener('click', () => {
      if (typeof window.callMeeting === 'function') {
        window.callMeeting(team.id, `${team.name} Meeting`);
      }
    });
  }

  async function loadTeamMeetings(teamId) {
    if (!els.meetingHistory) return;
    try {
      const res = await fetch(`/api/meetings?team=${teamId}&limit=10`);
      meetings = await res.json();
      renderMeetings();
    } catch { /* silent */ }
  }

  function renderMeetings() {
    if (!els.meetingHistory) return;

    if (meetings.length === 0) {
      els.meetingHistory.innerHTML = '<div class="meeting-empty">No meetings yet.</div>';
      return;
    }

    els.meetingHistory.innerHTML = '';
    for (const meeting of meetings) {
      const item = document.createElement('div');
      item.className = 'meeting-item';
      const isActive = meeting.status === 'active';
      const statusBadge = isActive ? '<span class="meeting-active-badge">ACTIVE</span>' : '';
      const timeStr = meeting.started_at ? new Date(meeting.started_at + 'Z').toLocaleString() : '';

      item.innerHTML = `
        <div class="meeting-title">${esc(meeting.title)} ${statusBadge}</div>
        <div class="meeting-meta">${timeStr}</div>
        <div class="meeting-notes-list" id="team-meeting-notes-${meeting.id}">
          <div class="meeting-empty" style="padding:6px;font-size:7px">Loading...</div>
        </div>
        ${isActive ? `<div style="margin-top:6px"><button class="pixel-btn small" data-action="end" data-id="${meeting.id}">End Meeting</button></div>` : ''}`;

      if (isActive) {
        item.querySelector('[data-action="end"]').addEventListener('click', (e) => {
          if (typeof window.endMeeting === 'function') {
            window.endMeeting(Number(e.target.dataset.id));
          }
        });
      }

      els.meetingHistory.appendChild(item);
      loadMeetingNotes(meeting.id);
    }
  }

  async function loadMeetingNotes(meetingId) {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/notes`);
      const notes = await res.json();
      const container = document.getElementById(`team-meeting-notes-${meetingId}`);
      if (!container) return;

      if (notes.length === 0) {
        container.innerHTML = '<div class="meeting-empty" style="padding:6px;font-size:7px">No notes.</div>';
        return;
      }

      container.innerHTML = '';
      for (const note of notes) {
        const noteEl = document.createElement('div');
        noteEl.className = 'meeting-note';
        noteEl.innerHTML = `
          ${note.agent_name ? `<div class="note-agent">${esc(note.agent_name)}</div>` : ''}
          <div>${esc(note.content)}</div>`;
        container.appendChild(noteEl);
      }
    } catch { /* silent */ }
  }

  // ── Socket event handlers ─────────────────────────────────

  function onMeetingStarted(meeting, team) {
    if (currentTeamId && els.overlay && !els.overlay.classList.contains('hidden')) {
      loadTeamMeetings(currentTeamId);
    }
  }

  function onMeetingEnded(meeting) {
    if (currentTeamId && els.overlay && !els.overlay.classList.contains('hidden')) {
      loadTeamMeetings(currentTeamId);
    }
  }

  function onMeetingNote(note, meetingId) {
    const container = document.getElementById(`team-meeting-notes-${meetingId}`);
    if (container) {
      const empty = container.querySelector('.meeting-empty');
      if (empty) empty.remove();

      const noteEl = document.createElement('div');
      noteEl.className = 'meeting-note';
      noteEl.innerHTML = `
        ${note.agent_name ? `<div class="note-agent">${esc(note.agent_name)}</div>` : ''}
        <div>${esc(note.content)}</div>`;
      container.appendChild(noteEl);
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  return {
    init, open, close,
    updateTeams, setAllAgents,
    onMeetingStarted, onMeetingEnded, onMeetingNote,
  };
})();
