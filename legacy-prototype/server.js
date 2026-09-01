// ============================================================
//  AgentHub — Server
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const AgentManager = require('./lib/agent-manager');
const TaskBoard = require('./lib/task-board');
const AgentBridge = require('./lib/agent-bridge');
const db = require('./lib/db');
const settings = require('./lib/settings');
const layout = require('./lib/layout');
const fs = require('fs');
const yaml = require('js-yaml');

// ── Boot ─────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Agent Manager ────────────────────────────────────────────

const agentManager = new AgentManager();
agentManager.load();
agentManager.watch();

const taskBoard = new TaskBoard(agentManager);
const agentBridge = new AgentBridge(agentManager, io);

agentManager.onChange(() => {
  const state = agentManager.getState();
  state.layout = layout.getAll();
  io.emit('state', state);
  console.log('[Server] Config reloaded — pushed new state to clients');
});

// ── REST API ─────────────────────────────────────────────────

// State (agents + office layout + positions)
app.get('/api/state', (_req, res) => {
  const state = agentManager.getState();
  state.layout = layout.getAll();
  const names = state.agents.map(a => a.name);
  for (const name of names) {
    if (!state.layout.cubicles[name]) {
      layout.autoAssign(name, names);
    }
  }
  state.layout = layout.getAll();
  res.json(state);
});

// Agent details
app.get('/api/agents/:name', (req, res) => {
  const agent = agentManager.get(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({
    name: agent.name,
    role: agent.role,
    avatar: agent.avatar,
    tier: agent.tier,
    status: agent.status,
    llmType: agent.llmConfig.type,
    llmModel: agent.llmConfig.model,
    messageCount: agent.messages.length,
  });
});

// Agent message history
app.get('/api/agents/:name/messages', (req, res) => {
  const msgs = db.getMessages(req.params.name, 100);
  res.json(msgs);
});

// Clear agent conversation
app.post('/api/agents/:name/clear', (req, res) => {
  agentManager.clearHistory(req.params.name);
  db.clearMessages(req.params.name);
  res.json({ ok: true });
});

// ── Tasks API ────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.agent) filter.agent_name = req.query.agent;
  if (req.query.board) filter.board_type = req.query.board;
  res.json(taskBoard.list(filter));
});

app.get('/api/tasks/summary', (req, res) => {
  if (req.query.board) {
    res.json(taskBoard.getSummary(req.query.board));
  } else {
    res.json(taskBoard.getAllSummaries());
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const task = taskBoard.create(req.body.title, req.body.description, req.body.agent_name, req.body.board_type || 'research');
    io.emit('task:created', task);
    io.emit('tasks', taskBoard.getAllSummaries());
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  try {
    const task = taskBoard.update(Number(req.params.id), req.body);
    io.emit('task:updated', task);
    io.emit('tasks', taskBoard.getAllSummaries());
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/assign', (req, res) => {
  try {
    const task = taskBoard.assign(Number(req.params.id), req.body.agent_name);
    io.emit('task:updated', task);
    io.emit('tasks', taskBoard.getAllSummaries());
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  taskBoard.delete(Number(req.params.id));
  io.emit('tasks', taskBoard.getAllSummaries());
  res.json({ ok: true });
});

// Agent next task
app.get('/api/agents/:name/next-task', (req, res) => {
  const next = taskBoard.getNextTask(req.params.name);
  res.json(next || { none: true });
});

// ── Teams API ────────────────────────────────────────────

app.get('/api/teams', (_req, res) => {
  const teams = db.listTeams();
  const teamMembers = {};
  for (const t of teams) {
    teamMembers[t.id] = db.getTeamMembers(t.id);
  }
  res.json({ teams, teamMembers });
});

app.post('/api/teams', (req, res) => {
  try {
    const { name, type, color, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const team = db.createTeam(name, type, color, description);
    io.emit('teams', buildTeamsPayload());
    recomputeLayoutAndBroadcast();
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/teams/:id', (req, res) => {
  try {
    const team = db.updateTeam(Number(req.params.id), req.body);
    io.emit('teams', buildTeamsPayload());
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/teams/:id', (req, res) => {
  db.deleteTeam(Number(req.params.id));
  io.emit('teams', buildTeamsPayload());
  recomputeLayoutAndBroadcast();
  res.json({ ok: true });
});

// Team members
app.get('/api/teams/:id/members', (req, res) => {
  res.json(db.getTeamMembers(Number(req.params.id)));
});

app.post('/api/teams/:id/members', (req, res) => {
  try {
    const { agent_name, role_in_team } = req.body;
    if (!agent_name) return res.status(400).json({ error: 'agent_name is required' });
    const members = db.addTeamMember(Number(req.params.id), agent_name, role_in_team);
    io.emit('teams', buildTeamsPayload());
    recomputeLayoutAndBroadcast();
    res.json(members);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/teams/:id/members/:agent', (req, res) => {
  db.removeTeamMember(Number(req.params.id), req.params.agent);
  io.emit('teams', buildTeamsPayload());
  recomputeLayoutAndBroadcast();
  res.json({ ok: true });
});

// ── Meetings API ─────────────────────────────────────────

app.get('/api/meetings', (req, res) => {
  const filter = {};
  if (req.query.team) filter.team_id = Number(req.query.team);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.limit) filter.limit = Number(req.query.limit);
  const meetings = db.listMeetings(filter);
  res.json(meetings);
});

app.post('/api/meetings', (req, res) => {
  try {
    const { team_id, title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const meeting = db.createMeeting(team_id || null, title);
    const team = team_id ? db.getTeam(team_id) : null;
    io.emit('meeting:started', { meeting, team });
    res.json(meeting);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/meetings/:id', (req, res) => {
  try {
    const meeting = db.endMeeting(Number(req.params.id));
    io.emit('meeting:ended', { meeting });
    res.json(meeting);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/meetings/:id/notes', (req, res) => {
  res.json(db.getMeetingNotes(Number(req.params.id)));
});

app.post('/api/meetings/:id/notes', (req, res) => {
  try {
    const { content, agent_name } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const note = db.addMeetingNote(Number(req.params.id), content, agent_name);
    io.emit('meeting:note', { note, meetingId: Number(req.params.id) });
    res.json(note);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Recompute auto-layout based on current team structure and broadcast state */
function recomputeLayoutAndBroadcast() {
  try {
    const agents = agentManager.getAll().map(a => ({ name: a.name, tier: a.tier }));
    const teams = db.listTeams();
    const teamMembersMap = {};
    for (const t of teams) {
      teamMembersMap[t.id] = db.getTeamMembers(t.id);
    }
    layout.computeAutoLayout(agents, teams, teamMembersMap);
    const state = agentManager.getState();
    state.layout = layout.getAll();
    io.emit('state', state);
  } catch (err) {
    console.error('[Server] Layout recompute failed:', err.message);
  }
}

/** Build the teams payload for socket broadcast */
function buildTeamsPayload() {
  const teams = db.listTeams();
  const teamMembers = {};
  const highlights = {};
  for (const t of teams) {
    const members = db.getTeamMembers(t.id);
    teamMembers[t.id] = members;
    // Check if team has an active meeting — if so, highlight all members
    const activeMeeting = db.getActiveMeeting(t.id);
    if (activeMeeting) {
      for (const m of members) {
        highlights[m.agent_name] = t.color;
      }
    }
  }
  return { teams, teamMembers, highlights };
}

// ── CEO Todos API ────────────────────────────────────────────

app.get('/api/ceo-todos', (_req, res) => {
  res.json(db.listCeoTodos());
});

app.post('/api/ceo-todos', (req, res) => {
  try {
    const { title, description, priority } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const todo = db.createCeoTodo(title, description, priority || 0);
    io.emit('ceo-todos', db.listCeoTodos());
    res.json(todo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/ceo-todos/:id', (req, res) => {
  try {
    const todo = db.updateCeoTodo(Number(req.params.id), req.body);
    io.emit('ceo-todos', db.listCeoTodos());
    res.json(todo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/ceo-todos/:id', (req, res) => {
  db.deleteCeoTodo(Number(req.params.id));
  io.emit('ceo-todos', db.listCeoTodos());
  res.json({ ok: true });
});

// ── Max Projects Setting ─────────────────────────────────────

app.get('/api/settings/max-projects', (_req, res) => {
  res.json({ maxProjects: settings.getMaxProjects() });
});

app.post('/api/settings/max-projects', (req, res) => {
  const { maxProjects } = req.body;
  const n = settings.setMaxProjects(maxProjects);
  io.emit('settings:maxProjects', n);
  res.json({ maxProjects: n });
});

// ── Layout API ───────────────────────────────────────────────

app.get('/api/layout', (_req, res) => {
  res.json(layout.getAll());
});

app.patch('/api/layout', (req, res) => {
  const { cubicles } = req.body;
  if (cubicles && typeof cubicles === 'object') {
    layout.bulkUpdate(cubicles);
  }
  io.emit('state', { ...agentManager.getState(), layout: layout.getAll() });
  res.json({ ok: true, layout: layout.getAll() });
});

// ── Add Agent API ────────────────────────────────────────────

app.post('/api/agents', (req, res) => {
  const { name, role, avatar, tier, personality } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'name and role are required' });
  }

  if (agentManager.get(name)) {
    return res.status(409).json({ error: `Agent "${name}" already exists` });
  }

  try {
    const configPath = require('path').join(__dirname, 'agents.yaml');
    let content = fs.readFileSync(configPath, 'utf8');

    const block = [
      '',
      `  # ── ${name} ────────────────────────────────────────────────`,
      `  - name: ${name}`,
      `    role: ${role}`,
      `    tier: ${tier || 'senior'}`,
      `    avatar: ${avatar || 'blue'}`,
      `    personality: >`,
      `      ${personality || `You are ${name}, a ${role.toLowerCase()}. Be helpful and concise.`}`,
      '',
    ].join('\n');

    content += block;
    fs.writeFileSync(configPath, content, 'utf8');

    const names = agentManager.getAll().map(a => a.name).concat(name);
    layout.autoAssign(name, names);

    setTimeout(() => {
      agentManager.load();
      const state = agentManager.getState();
      state.layout = layout.getAll();
      io.emit('state', state);
    }, 200);

    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fire Agent API ───────────────────────────────────────────

app.delete('/api/agents/:name', (req, res) => {
  const name = req.params.name;
  try {
    agentManager.fireAgent(name);
    layout.removeCubicle(name);

    // Remove from all teams in DB
    try {
      const agentTeams = db.getAgentTeams(name);
      for (const t of agentTeams) {
        db.removeTeamMember(t.id, name);
      }
    } catch { /* silent — agent might not be in any teams */ }

    // Also delete agent messages from DB
    try {
      db.clearMessages(name);
    } catch { /* silent */ }

    setTimeout(() => {
      agentManager.load();
      const state = agentManager.getState();
      state.layout = layout.getAll();
      io.emit('state', state);
      io.emit('teams', buildTeamsPayload());
    }, 200);

    res.json({ ok: true, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Settings API ─────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(settings.getSafe());
});

app.post('/api/settings/global-key', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  settings.setGlobalKey(apiKey);
  agentManager.reconfigureAll();
  io.emit('state', agentManager.getState());
  res.json({ ok: true, masked: settings.maskKey(apiKey) });
});

app.patch('/api/settings/agents/:name', (req, res) => {
  const name = req.params.name;
  if (!agentManager.get(name)) {
    return res.status(404).json({ error: `Agent "${name}" not found` });
  }
  const { llmType, model, url, apiKey } = req.body;
  settings.setAgentConfig(name, { llmType, model, url, apiKey });
  agentManager.reconfigureAgent(name);
  io.emit('state', agentManager.getState());
  res.json({ ok: true, settings: settings.getSafe() });
});

app.delete('/api/settings/agents/:name', (req, res) => {
  const name = req.params.name;
  settings.clearAgentConfig(name);
  agentManager.reconfigureAgent(name);
  io.emit('state', agentManager.getState());
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Send initial state with layout
  const initState = agentManager.getState();
  initState.layout = layout.getAll();
  socket.emit('state', initState);
  socket.emit('tasks', taskBoard.getAllSummaries());
  socket.emit('teams', buildTeamsPayload());
  socket.emit('ceo-todos', db.listCeoTodos());
  socket.emit('settings:maxProjects', settings.getMaxProjects());

  // ── Chat with an agent ───────────────────────────────────
  socket.on('chat', async ({ agentName, message, taskId }) => {
    if (!agentName || !message) return;

    const agent = agentManager.get(agentName);
    if (!agent) {
      socket.emit('chat:error', { agentName, error: 'Agent not found' });
      return;
    }

    db.addMessage(agentName, 'user', message, taskId || null);

    if (taskId) {
      try {
        taskBoard.updateStatus(taskId, 'in_progress');
        io.emit('tasks', taskBoard.getAllSummaries());
      } catch { /* ignore */ }
    }

    io.emit('state', agentManager.getState());

    let fullResponse = '';
    try {
      for await (const chunk of agentManager.chat(agentName, message, taskId)) {
        switch (chunk.type) {
          case 'token':
            socket.emit('chat:token', { agentName, text: chunk.text });
            fullResponse += chunk.text;
            break;

          case 'delegation':
            await agentBridge.handleDelegation(
              agentName, chunk.target, chunk.message, socket.id
            );
            break;

          case 'hire':
            // Director wants to hire an agent
            try {
              const result = agentManager.hireAgent(
                chunk.name, chunk.role, chunk.tier
              );
              const names = agentManager.getAll().map(a => a.name).concat(chunk.name);
              layout.autoAssign(chunk.name, names);

              // Reload to pick up the new agent
              setTimeout(() => {
                agentManager.load();
                const state = agentManager.getState();
                state.layout = layout.getAll();
                io.emit('state', state);
                io.emit('agent:hired', {
                  name: chunk.name,
                  role: chunk.role,
                  tier: chunk.tier,
                  by: agentName,
                });
              }, 300);

              console.log(`[Server] ${agentName} hired ${chunk.name} (${chunk.role})`);
            } catch (err) {
              console.error(`[Server] Hire failed: ${err.message}`);
            }
            break;

          case 'fire':
            // Director wants to fire an agent
            try {
              agentManager.fireAgent(chunk.name);
              layout.removeCubicle(chunk.name);

              io.emit('agent:fired', { name: chunk.name, by: agentName });

              setTimeout(() => {
                agentManager.load();
                const state = agentManager.getState();
                state.layout = layout.getAll();
                io.emit('state', state);
              }, 300);

              console.log(`[Server] ${agentName} fired ${chunk.name}`);
            } catch (err) {
              console.error(`[Server] Fire failed: ${err.message}`);
            }
            break;

          case 'team':
            // CEO team management commands
            try {
              const tc = chunk;
              if (tc.action === 'create') {
                const team = db.createTeam(tc.teamName, tc.teamType || 'research', tc.color);
                console.log(`[Server] ${agentName} created team: ${tc.teamName}`);
              } else if (tc.action === 'assign') {
                const team = db.getTeamByName(tc.teamName);
                if (team) {
                  db.addTeamMember(team.id, tc.agentName, tc.roleInTeam || 'member');
                  console.log(`[Server] ${agentName} assigned ${tc.agentName} to ${tc.teamName}`);
                }
              } else if (tc.action === 'remove') {
                const team = db.getTeamByName(tc.teamName);
                if (team) {
                  db.removeTeamMember(team.id, tc.agentName);
                  console.log(`[Server] ${agentName} removed ${tc.agentName} from ${tc.teamName}`);
                }
              }
              io.emit('teams', buildTeamsPayload());
              recomputeLayoutAndBroadcast();
            } catch (err) {
              console.error(`[Server] Team command failed: ${err.message}`);
            }
            break;

          case 'meeting':
            // CEO meeting commands
            try {
              const mc = chunk;
              if (mc.action === 'start') {
                const team = db.getTeamByName(mc.teamName);
                const teamId = team ? team.id : null;
                const meeting = db.createMeeting(teamId, mc.title || `Meeting: ${mc.teamName}`);
                io.emit('meeting:started', { meeting, team });
                io.emit('teams', buildTeamsPayload());
                console.log(`[Server] ${agentName} started meeting: ${mc.title || mc.teamName}`);
              } else if (mc.action === 'end') {
                const team = db.getTeamByName(mc.teamName);
                if (team) {
                  const active = db.getActiveMeeting(team.id);
                  if (active) {
                    db.endMeeting(active.id);
                    io.emit('meeting:ended', { meeting: active });
                    io.emit('teams', buildTeamsPayload());
                    console.log(`[Server] ${agentName} ended meeting for ${mc.teamName}`);
                  }
                }
              } else if (mc.action === 'note') {
                const team = db.getTeamByName(mc.teamName);
                if (team) {
                  const active = db.getActiveMeeting(team.id);
                  if (active) {
                    const note = db.addMeetingNote(active.id, mc.content, agentName);
                    io.emit('meeting:note', { note, meetingId: active.id });
                    console.log(`[Server] ${agentName} added meeting note for ${mc.teamName}`);
                  }
                }
              }
            } catch (err) {
              console.error(`[Server] Meeting command failed: ${err.message}`);
            }
            break;

          case 'done':
            db.addMessage(agentName, 'assistant', chunk.fullResponse, taskId || null);
            socket.emit('chat:done', { agentName, fullResponse: chunk.fullResponse });
            break;

          case 'error':
            socket.emit('chat:error', { agentName, error: chunk.error });
            break;
        }
      }
    } catch (err) {
      socket.emit('chat:error', { agentName, error: err.message });
      agentManager.setStatus(agentName, 'error');
    }

    io.emit('state', agentManager.getState());
  });

  // ── Meeting socket events (UI-triggered) ─────────────────
  socket.on('meeting:start', ({ teamId, title }) => {
    try {
      const meeting = db.createMeeting(teamId || null, title || 'Meeting');
      const team = teamId ? db.getTeam(teamId) : null;
      io.emit('meeting:started', { meeting, team });
      io.emit('teams', buildTeamsPayload());
    } catch (err) {
      console.error(`[Server] Meeting start failed: ${err.message}`);
    }
  });

  socket.on('meeting:end', ({ meetingId }) => {
    try {
      const meeting = db.endMeeting(meetingId);
      io.emit('meeting:ended', { meeting });
      io.emit('teams', buildTeamsPayload());
    } catch (err) {
      console.error(`[Server] Meeting end failed: ${err.message}`);
    }
  });

  // ── Clear agent history ──────────────────────────────────
  socket.on('agent:clear', ({ agentName }) => {
    agentManager.clearHistory(agentName);
    db.clearMessages(agentName);
    socket.emit('agent:cleared', { agentName });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ── Start ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║          AgentHub is running!            ║');
  console.log(`  ║   http://localhost:${PORT}                   ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
