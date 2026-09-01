// ============================================================
//  App — main entry point, Socket.IO, team/meeting events
// ============================================================

(function () {
  const socket = io();
  let currentState = { agents: [], office: { name: 'HQ', columns: 4 }, layout: {} };

  // ── Init ────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    Office.init(document.getElementById('office'));
    AgentPanel.init();
    TaskBoardUI.init();
    SettingsUI.init();
    CeoTodoUI.init();
    TeamPanel.init();

    // Create Team modal
    const createTeamOverlay = document.getElementById('createTeamOverlay');
    document.getElementById('btnCloseCreateTeam').addEventListener('click', () => {
      createTeamOverlay.classList.add('hidden');
    });
    createTeamOverlay.addEventListener('click', (e) => {
      if (e.target === createTeamOverlay) createTeamOverlay.classList.add('hidden');
    });
    document.getElementById('btnConfirmCreateTeam').addEventListener('click', createTeam);
    document.getElementById('createTeamName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createTeam();
    });

    // Add agent modal
    const addOverlay = document.getElementById('addAgentOverlay');
    document.getElementById('btnCloseAddAgent').addEventListener('click', () => {
      addOverlay.classList.add('hidden');
    });
    addOverlay.addEventListener('click', (e) => {
      if (e.target === addOverlay) addOverlay.classList.add('hidden');
    });
    document.getElementById('btnConfirmAddAgent').addEventListener('click', createAgent);
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: STATE
  // ══════════════════════════════════════════════════════════

  socket.on('state', (state) => {
    currentState = state;
    Office.update(state);
    AgentPanel.updateAgent(state.agents);
    TaskBoardUI.updateAgents(state.agents);
    SettingsUI.updateAgents(state.agents);
    TeamPanel.setAllAgents(state.agents);

    document.getElementById('officeName').textContent = state.office?.name || 'HQ';
    document.getElementById('agentCount').textContent =
      `${state.agents.length} agent${state.agents.length !== 1 ? 's' : ''}`;
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: TASKS
  // ══════════════════════════════════════════════════════════

  socket.on('tasks', (summaries) => {
    TaskBoardUI.updateTasks(summaries);
    Office.updateTaskCounts(summaries);
    AgentPanel.refreshTasks();
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: CEO TODOS
  // ══════════════════════════════════════════════════════════

  socket.on('ceo-todos', (todos) => {
    CeoTodoUI.updateTodos(todos);
  });

  socket.on('settings:maxProjects', (n) => {
    CeoTodoUI.updateMaxProjects(n);
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: CHAT STREAMING
  // ══════════════════════════════════════════════════════════

  socket.on('chat:token', ({ agentName, text }) => {
    if (AgentPanel.getCurrentName() === agentName) {
      AgentPanel.appendStreamToken(text);
    }
  });

  socket.on('chat:done', ({ agentName }) => {
    if (AgentPanel.getCurrentName() === agentName) {
      AgentPanel.endStream();
    }
  });

  socket.on('chat:error', ({ agentName, error }) => {
    if (AgentPanel.getCurrentName() === agentName) {
      AgentPanel.endStream();
      AgentPanel.addMessage('assistant', `[Error] ${error}`);
    }
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: DELEGATION
  // ══════════════════════════════════════════════════════════

  socket.on('delegation:start', ({ source, target }) => {
    Office.showBubble(source, `Asking ${target}...`, 20);
  });

  socket.on('delegation:done', ({ source, target, response }) => {
    Office.showBubble(source, 'Got response!', 16);
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: HIRE / FIRE
  // ══════════════════════════════════════════════════════════

  socket.on('agent:hired', ({ name, role, tier }) => {
    Office.showBubble(name, 'Reporting for duty!', 25);
  });

  socket.on('agent:fired', ({ name, by }) => {
    Office.showBubble(name, 'Goodbye...', 20);
  });

  // ══════════════════════════════════════════════════════════
  //  SOCKET: TEAMS + MEETINGS
  // ══════════════════════════════════════════════════════════

  socket.on('teams', (data) => {
    // data = { teams, teamMembers, highlights }
    if (data.highlights) {
      Office.setTeamHighlights(data.highlights);
    }

    // Compute team sections for enclosure layout
    const sections = (data.teams || []).map(team => ({
      teamId: team.id,
      teamName: team.name,
      label: team.name,
      type: team.type,
      color: team.color || '#53d8fb',
      description: team.description || '',
      agents: (data.teamMembers[team.id] || []).map(m => m.agent_name),
    }));
    Office.setTeamSections(sections);
    // Trigger re-layout
    Office.update(currentState);

    // Update team panel
    TeamPanel.updateTeams(data.teams || [], data.teamMembers || {});
  });

  socket.on('meeting:started', ({ meeting, team }) => {
    TeamPanel.onMeetingStarted(meeting, team);
  });

  socket.on('meeting:ended', ({ meeting }) => {
    TeamPanel.onMeetingEnded(meeting);
  });

  socket.on('meeting:note', ({ note, meetingId }) => {
    TeamPanel.onMeetingNote(note, meetingId);
  });

  // ══════════════════════════════════════════════════════════
  //  GLOBAL CLICK HANDLERS
  // ══════════════════════════════════════════════════════════

  window.onAgentClick = function (agentName) {
    AgentPanel.open(agentName, currentState.agents);
  };

  // Old board click handler (kept for backward compat)
  window.onBoardClick = function (boardType) {
    TaskBoardUI.open(boardType);
  };

  // CEO directives board click
  window.onCeoBoardClick = function () {
    CeoTodoUI.open();
  };

  // Team enclosure header click
  window.onTeamEnclosureClick = function (teamId) {
    TeamPanel.open(teamId);
  };

  // Create Team click (from canvas placeholder)
  window.onCreateTeamClick = function () {
    populateCreateTeamAgents();
    document.getElementById('createTeamOverlay').classList.remove('hidden');
    document.getElementById('createTeamName').focus();
  };

  window.onAddAgentClick = function () {
    document.getElementById('addAgentOverlay').classList.remove('hidden');
    document.getElementById('addAgentName').focus();
  };

  window.sendChatMessage = function (agentName, message) {
    socket.emit('chat', { agentName, message });
  };

  window.clearAgentChat = function (agentName) {
    socket.emit('agent:clear', { agentName });
  };

  window.onAgentArrived = function (agentName, destination) {
    if (destination?.type === 'desk') {
      AgentPanel.open(agentName, currentState.agents);
      Office.showBubble(agentName, `Hey ${destination.name}!`, 20);
    } else if (destination?.type === 'board') {
      AgentPanel.open(agentName, currentState.agents);
      Office.showBubble(agentName, 'Checking the board...', 16);
    }
  };

  // ── Meeting actions (called by TeamPanel) ─────────────────

  window.callMeeting = function (teamId, title) {
    socket.emit('meeting:start', { teamId, title });
  };

  window.endMeeting = function (meetingId) {
    socket.emit('meeting:end', { meetingId });
  };

  // ══════════════════════════════════════════════════════════
  //  CREATE AGENT (from modal)
  // ══════════════════════════════════════════════════════════

  async function createAgent() {
    const name = document.getElementById('addAgentName').value.trim();
    const role = document.getElementById('addAgentRole').value.trim();
    const avatar = document.getElementById('addAgentAvatar').value;
    const tier = document.getElementById('addAgentTier').value;
    const personality = document.getElementById('addAgentPersonality').value.trim();
    const status = document.getElementById('addAgentStatus');

    if (!name || !role) {
      status.textContent = 'Name and role are required';
      status.className = 'settings-status err';
      return;
    }

    status.textContent = 'Creating...';
    status.className = 'settings-status';

    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role, avatar, tier, personality }),
      });

      const data = await res.json();
      if (res.ok) {
        status.textContent = `${name} added!`;
        status.className = 'settings-status ok';
        document.getElementById('addAgentName').value = '';
        document.getElementById('addAgentRole').value = '';
        document.getElementById('addAgentPersonality').value = '';
        setTimeout(() => {
          document.getElementById('addAgentOverlay').classList.add('hidden');
          status.textContent = '';
        }, 1000);
      } else {
        status.textContent = data.error || 'Failed';
        status.className = 'settings-status err';
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status err';
    }
  }
  // ══════════════════════════════════════════════════════════
  //  CREATE TEAM (from modal)
  // ══════════════════════════════════════════════════════════

  function populateCreateTeamAgents() {
    const container = document.getElementById('createTeamAgents');
    if (!container) return;
    container.innerHTML = '';
    const agents = currentState.agents || [];
    for (const a of agents) {
      if (a.tier === 'director') continue; // CEO doesn't join teams
      const item = document.createElement('label');
      item.className = 'create-team-agent-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = a.name;
      cb.addEventListener('change', () => {
        item.classList.toggle('selected', cb.checked);
      });
      item.appendChild(cb);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${a.name} (${a.role})`;
      item.appendChild(nameSpan);
      container.appendChild(item);
    }
    if (agents.filter(a => a.tier !== 'director').length === 0) {
      container.innerHTML = '<span style="font-size:7px;color:var(--text-dim)">No agents available.</span>';
    }
  }

  async function createTeam() {
    const name = document.getElementById('createTeamName').value.trim();
    const type = document.getElementById('createTeamType').value;
    const color = document.getElementById('createTeamColor').value;
    const description = document.getElementById('createTeamDesc').value.trim();
    const status = document.getElementById('createTeamStatus');

    // Collect selected agents
    const checkboxes = document.querySelectorAll('#createTeamAgents input[type="checkbox"]:checked');
    const selectedAgents = Array.from(checkboxes).map(cb => cb.value);

    if (!name) {
      status.textContent = 'Team name is required';
      status.className = 'settings-status err';
      return;
    }

    status.textContent = 'Creating...';
    status.className = 'settings-status';

    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, color, description }),
      });

      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || 'Failed to create team';
        status.className = 'settings-status err';
        return;
      }

      const teamId = data.id;

      // Add selected members
      if (selectedAgents.length > 0) {
        status.textContent = 'Adding members...';
        for (const agentName of selectedAgents) {
          await fetch(`/api/teams/${teamId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: agentName }),
          });
        }
      }

      status.textContent = `Team "${name}" created!`;
      status.className = 'settings-status ok';
      document.getElementById('createTeamName').value = '';
      document.getElementById('createTeamDesc').value = '';
      setTimeout(() => {
        document.getElementById('createTeamOverlay').classList.add('hidden');
        status.textContent = '';
      }, 800);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status err';
    }
  }
})();
