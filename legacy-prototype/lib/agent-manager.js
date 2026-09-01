// Agent Manager — loads agents.yaml, manages lifecycle, hot-reload, hire/fire

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chokidar = require('chokidar');
const { createConnector } = require('./llm');
const settings = require('./settings');

const CONFIG_PATH = path.join(__dirname, '..', 'agents.yaml');

class AgentManager {
  constructor() {
    this.agents = new Map();
    this.office = { name: 'HQ', columns: 4 };
    this._onChange = null;
  }

  /** Load agents.yaml and create connectors */
  load() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = yaml.load(raw);

    if (config.office) {
      this.office = { ...this.office, ...config.office };
    }

    const defaults = config.defaults || {};
    const defaultLlm = defaults.llm || { type: 'anthropic', model: 'claude-sonnet-4-20250514' };

    const newAgents = new Map();

    for (const agentConf of config.agents || []) {
      const name = agentConf.name;
      if (!name) continue;

      const llmConfig = settings.resolveAgentLlm(defaultLlm, agentConf.llm, name);
      const existing = this.agents.get(name);

      let connector;
      try {
        connector = createConnector(llmConfig);
      } catch (err) {
        console.error(`[AgentManager] Failed to create connector for ${name}: ${err.message}`);
        continue;
      }

      const defaultTier = defaults.tier || 'senior';
      newAgents.set(name, {
        name,
        role: agentConf.role || 'Agent',
        avatar: agentConf.avatar || 'blue',
        tier: agentConf.tier || defaultTier,
        personality: (agentConf.personality || '').trim(),
        llmConfig,
        connector,
        status: existing?.status || 'idle',
        currentTask: existing?.currentTask || null,
        messages: existing?.messages || [],
      });
    }

    this.agents = newAgents;
    console.log(`[AgentManager] Loaded ${this.agents.size} agents: ${[...this.agents.keys()].join(', ')}`);
  }

  /** Watch agents.yaml for changes and hot-reload */
  watch() {
    const watcher = chokidar.watch(CONFIG_PATH, { ignoreInitial: true });
    watcher.on('change', () => {
      console.log('[AgentManager] agents.yaml changed — reloading...');
      try {
        this.load();
        if (this._onChange) this._onChange(this.getAll());
      } catch (err) {
        console.error('[AgentManager] Reload error:', err.message);
      }
    });
  }

  onChange(fn) { this._onChange = fn; }

  get(name) { return this.agents.get(name) || null; }

  getAll() { return [...this.agents.values()]; }

  /** Get the top-level agent (highest tier) */
  getDirector() {
    const tierRank = { director: 4, manager: 3, senior: 2, junior: 1 };
    let top = null;
    let topRank = 0;
    for (const agent of this.agents.values()) {
      const rank = tierRank[agent.tier] || 0;
      if (rank > topRank) { top = agent; topRank = rank; }
    }
    return top;
  }

  /** Get serializable state for the frontend */
  getState() {
    return {
      office: this.office,
      agents: this.getAll().map(a => ({
        name: a.name,
        role: a.role,
        avatar: a.avatar,
        tier: a.tier || 'senior',
        status: a.status,
        currentTask: a.currentTask,
        llmType: a.llmConfig.type,
        llmModel: a.llmConfig.model,
      })),
    };
  }

  setStatus(name, status) {
    const agent = this.agents.get(name);
    if (agent) agent.status = status;
  }

  /** Send a message to an agent and stream the response */
  async *chat(name, userMessage, taskId = null) {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);

    agent.messages.push({ role: 'user', content: userMessage });
    const systemPrompt = this._buildSystemPrompt(agent);
    agent.status = 'working';

    try {
      let fullResponse = '';

      for await (const chunk of agent.connector.stream(agent.messages, systemPrompt)) {
        if (chunk.text) {
          fullResponse += chunk.text;
          yield { type: 'token', text: chunk.text };
        }
        if (chunk.done) break;
      }

      agent.messages.push({ role: 'assistant', content: fullResponse });

      // Check for delegation requests
      const delegation = this._parseDelegation(fullResponse);
      if (delegation) {
        yield { type: 'delegation', target: delegation.target, message: delegation.message };
      }

      // Check for hire/fire commands (director only)
      const hireCmd = this._parseHire(fullResponse);
      if (hireCmd && agent.tier === 'director') {
        yield { type: 'hire', ...hireCmd };
      }

      const fireCmd = this._parseFire(fullResponse);
      if (fireCmd && agent.tier === 'director') {
        yield { type: 'fire', ...fireCmd };
      }

      // Check for team/meeting commands (director only)
      if (agent.tier === 'director') {
        for (const teamCmd of this._parseTeamCommands(fullResponse)) {
          yield teamCmd;
        }
        for (const meetingCmd of this._parseMeetingCommands(fullResponse)) {
          yield meetingCmd;
        }
      }

      agent.status = 'idle';
      yield { type: 'done', fullResponse };
    } catch (err) {
      agent.status = 'error';
      yield { type: 'error', error: err.message };
    }
  }

  // ── Hire / Fire ───────────────────────────────────────────

  /**
   * Hire a new agent (called when director uses [HIRE:...] command)
   * Returns the new agent name or throws.
   */
  hireAgent(name, role, tier = 'junior', avatar = null, personality = null) {
    if (this.agents.get(name)) {
      throw new Error(`Agent "${name}" already exists`);
    }

    // Pick a random avatar if not specified
    const avatarOptions = ['blue', 'green', 'purple', 'red', 'orange', 'teal', 'yellow', 'pink'];
    const usedAvatars = new Set(this.getAll().map(a => a.avatar));
    const availableAvatars = avatarOptions.filter(a => !usedAvatars.has(a));
    const finalAvatar = avatar || (availableAvatars.length > 0 ? availableAvatars[0] : 'blue');

    const finalPersonality = personality || `You are ${name}, a ${role.toLowerCase()}. Be helpful and concise.`;

    // Append to agents.yaml
    const configPath = CONFIG_PATH;
    let content = fs.readFileSync(configPath, 'utf8');
    const block = [
      '',
      `  # ── ${name} (hired) ──────────────────────────────────────`,
      `  - name: ${name}`,
      `    role: ${role}`,
      `    tier: ${tier}`,
      `    avatar: ${finalAvatar}`,
      `    personality: >`,
      `      ${finalPersonality}`,
      '',
    ].join('\n');

    content += block;
    fs.writeFileSync(configPath, content, 'utf8');

    console.log(`[AgentManager] Hired: ${name} (${role}, ${tier})`);
    return { name, role, tier, avatar: finalAvatar };
  }

  /**
   * Fire an agent — removes from yaml and unloads
   */
  fireAgent(name) {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);

    // Cannot fire directors
    if (agent.tier === 'director') {
      throw new Error('Cannot fire a director');
    }

    // Remove from agents.yaml
    const configPath = CONFIG_PATH;
    let content = fs.readFileSync(configPath, 'utf8');

    // Find and remove the agent block from YAML
    // This is a best-effort removal
    const lines = content.split('\n');
    const newLines = [];
    let inAgentBlock = false;
    let skipUntilNext = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check if this line starts our agent's block
      if (trimmed === `- name: ${name}`) {
        inAgentBlock = true;
        skipUntilNext = true;
        // Also skip the comment line before it (if it matches)
        if (newLines.length > 0 && newLines[newLines.length - 1].trim().startsWith(`# ── ${name}`)) {
          newLines.pop();
        }
        // Also remove trailing blank line before the block
        while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
          newLines.pop();
        }
        continue;
      }

      if (skipUntilNext) {
        // Skip lines until we hit the next agent (- name:) or end of agents section
        if (trimmed.startsWith('- name:') || (!trimmed.startsWith('#') && !trimmed.startsWith('-') && !line.startsWith('    ') && !line.startsWith('  ') && trimmed !== '')) {
          skipUntilNext = false;
          newLines.push(line);
        }
        // Skip this line (part of the removed agent block)
        continue;
      }

      newLines.push(line);
    }

    fs.writeFileSync(configPath, newLines.join('\n'), 'utf8');
    this.agents.delete(name);

    console.log(`[AgentManager] Fired: ${name}`);
    return { name };
  }

  /** Reconfigure an agent's LLM connector at runtime */
  reconfigureAgent(name) {
    const agent = this.agents.get(name);
    if (!agent) return false;

    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = yaml.load(raw);
    const defaults = config.defaults || {};
    const defaultLlm = defaults.llm || { type: 'anthropic', model: 'claude-sonnet-4-20250514' };
    const agentConf = (config.agents || []).find(a => a.name === name);
    if (!agentConf) return false;

    const llmConfig = settings.resolveAgentLlm(defaultLlm, agentConf.llm, name);

    try {
      agent.connector = createConnector(llmConfig);
      agent.llmConfig = llmConfig;
      agent.status = 'idle';
      console.log(`[AgentManager] Reconfigured ${name}: ${llmConfig.type}/${llmConfig.model}`);
      return true;
    } catch (err) {
      console.error(`[AgentManager] Reconfigure failed for ${name}: ${err.message}`);
      agent.status = 'error';
      return false;
    }
  }

  reconfigureAll() {
    for (const name of this.agents.keys()) {
      this.reconfigureAgent(name);
    }
  }

  clearHistory(name) {
    const agent = this.agents.get(name);
    if (agent) agent.messages = [];
  }

  /** Build system prompt with personality + delegation + hire/fire */
  _buildSystemPrompt(agent) {
    const otherAgents = this.getAll()
      .filter(a => a.name !== agent.name)
      .map(a => `- ${a.name} (${a.role}, ${a.tier})`)
      .join('\n');

    let prompt = `${agent.personality}

You are part of a team in a virtual office called "${this.office.name}".
Your role: ${agent.role}
Your tier: ${agent.tier}

Your colleagues:
${otherAgents || '(none yet)'}

If you need help from a colleague, delegate by including this on its own line:
[DELEGATE:ColleagueName] Your request to them here

Only delegate when genuinely useful. Most of the time, handle things yourself.`;

    // Director gets hire/fire + team organization capabilities
    if (agent.tier === 'director') {
      prompt += `

As the CEO/director, you organize the team. The user gives you directives via the CEO Directives board.
Your job: read directives, create teams (research or production), assign agents, and manage work.

IMPORTANT: You can only run up to the configured max concurrent projects at a time. Create teams strategically.

To hire a new agent:
[HIRE:Name,Role,Tier] Reason for hiring
Example: [HIRE:Eve,Security Analyst,senior] We need security expertise for the auth project

To fire an agent (only if truly not needed):
[FIRE:Name] Reason for firing

Valid tiers: director, manager, senior, junior

To create a team (agents will be grouped in an enclosure on the office floor):
[TEAM:Create,TeamName,Type] (Type: research or production)
Example: [TEAM:Create,Security Research,research]
Example: [TEAM:Create,Dashboard Build,production]

To assign an agent to a team:
[TEAM:Assign,AgentName,TeamName]
Example: [TEAM:Assign,Alice,Security Research]

To remove an agent from a team:
[TEAM:Remove,AgentName,TeamName]

To start a meeting with a team (their enclosure will glow):
[MEETING:Start,TeamName,Meeting Title]
Example: [MEETING:Start,Security Research,Sprint Planning]

To end a meeting:
[MEETING:End,TeamName]

To add a note to an active meeting:
[MEETING:Note,TeamName,Note content here]

When the user asks you to work on something, create appropriate teams, assign agents based on their skills, and delegate work. Each team shows up as a walled enclosure on the office floor with RESEARCH or PROJECT label.`;
    }

    return prompt;
  }

  _parseDelegation(text) {
    const match = text.match(/\[DELEGATE:(\w+)\]\s*(.+)/);
    if (match) return { target: match[1], message: match[2].trim() };
    return null;
  }

  _parseHire(text) {
    const match = text.match(/\[HIRE:(\w+),([^,]+),(\w+)\]\s*(.*)/);
    if (match) {
      return {
        name: match[1].trim(),
        role: match[2].trim(),
        tier: match[3].trim(),
        reason: match[4].trim(),
      };
    }
    return null;
  }

  _parseFire(text) {
    const match = text.match(/\[FIRE:(\w+)\]\s*(.*)/);
    if (match) {
      return { name: match[1].trim(), reason: match[2].trim() };
    }
    return null;
  }

  /** Parse all [TEAM:...] commands from response */
  _parseTeamCommands(text) {
    const results = [];
    const createRe = /\[TEAM:Create,([^,\]]+),([^\]]+)\]/g;
    const assignRe = /\[TEAM:Assign,([^,\]]+),([^\]]+)\]/g;
    const removeRe = /\[TEAM:Remove,([^,\]]+),([^\]]+)\]/g;

    let m;
    while ((m = createRe.exec(text)) !== null) {
      results.push({
        type: 'team', action: 'create',
        teamName: m[1].trim(), teamType: m[2].trim(),
      });
    }
    while ((m = assignRe.exec(text)) !== null) {
      results.push({
        type: 'team', action: 'assign',
        agentName: m[1].trim(), teamName: m[2].trim(),
      });
    }
    while ((m = removeRe.exec(text)) !== null) {
      results.push({
        type: 'team', action: 'remove',
        agentName: m[1].trim(), teamName: m[2].trim(),
      });
    }
    return results;
  }

  /** Parse all [MEETING:...] commands from response */
  _parseMeetingCommands(text) {
    const results = [];
    const startRe = /\[MEETING:Start,([^,\]]+),([^\]]+)\]/g;
    const endRe = /\[MEETING:End,([^\]]+)\]/g;
    const noteRe = /\[MEETING:Note,([^,\]]+),([^\]]+)\]/g;

    let m;
    while ((m = startRe.exec(text)) !== null) {
      results.push({
        type: 'meeting', action: 'start',
        teamName: m[1].trim(), title: m[2].trim(),
      });
    }
    while ((m = endRe.exec(text)) !== null) {
      results.push({
        type: 'meeting', action: 'end',
        teamName: m[1].trim(),
      });
    }
    while ((m = noteRe.exec(text)) !== null) {
      results.push({
        type: 'meeting', action: 'note',
        teamName: m[1].trim(), content: m[2].trim(),
      });
    }
    return results;
  }
}

module.exports = AgentManager;
