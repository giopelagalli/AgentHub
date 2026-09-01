// ============================================================
//  Settings — secure API key + LLM config management
//  Stores keys in data/settings.json (gitignored, never exposed raw)
// ============================================================

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULTS = {
  globalApiKey: '',
  agents: {},
  maxProjects: 3,
  // agents.AgentName = { llmType, model, apiKey, url }
};

/** Load settings from disk */
function load() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('[Settings] Failed to load settings.json:', err.message);
  }

  // Bootstrap from .env if settings.json doesn't exist yet
  const envKey = process.env.ANTHROPIC_API_KEY || '';
  const initial = { ...DEFAULTS, globalApiKey: envKey };
  save(initial);
  return initial;
}

/** Save settings to disk */
function save(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[Settings] Failed to save settings.json:', err.message);
  }
}

/** Mask a key for display: "sk-ant-abc...xyz1234" → "sk-a...1234" */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ── Public API ──────────────────────────────────────────────

/** Get the global API key (raw — internal use only) */
function getGlobalKey() {
  const s = load();
  return s.globalApiKey || process.env.ANTHROPIC_API_KEY || '';
}

/** Set the global API key */
function setGlobalKey(key) {
  const s = load();
  s.globalApiKey = key.trim();
  save(s);

  // Also update process.env so connectors pick it up immediately
  process.env.ANTHROPIC_API_KEY = s.globalApiKey;
}

/** Get per-agent LLM overrides (raw — internal use only) */
function getAgentConfig(agentName) {
  const s = load();
  return s.agents[agentName] || null;
}

/** Set per-agent LLM config */
function setAgentConfig(agentName, config) {
  const s = load();
  if (!s.agents) s.agents = {};

  // Only store non-empty values
  const cleaned = {};
  if (config.llmType)  cleaned.llmType = config.llmType;
  if (config.model)    cleaned.model = config.model;
  if (config.url)      cleaned.url = config.url;
  if (config.apiKey !== undefined) cleaned.apiKey = config.apiKey; // allow empty to clear

  if (Object.keys(cleaned).length === 0) {
    delete s.agents[agentName]; // remove override, use defaults
  } else {
    s.agents[agentName] = cleaned;
  }

  save(s);
}

/** Remove per-agent override (reset to defaults) */
function clearAgentConfig(agentName) {
  const s = load();
  delete s.agents[agentName];
  save(s);
}

/**
 * Get safe (masked) settings for the frontend.
 * NEVER exposes raw keys.
 */
function getSafe() {
  const s = load();
  return {
    globalApiKey: maskKey(s.globalApiKey || process.env.ANTHROPIC_API_KEY || ''),
    hasGlobalKey: !!(s.globalApiKey || process.env.ANTHROPIC_API_KEY),
    agents: Object.fromEntries(
      Object.entries(s.agents || {}).map(([name, conf]) => [
        name,
        {
          llmType: conf.llmType || null,
          model: conf.model || null,
          url: conf.url || null,
          hasCustomKey: !!conf.apiKey,
          apiKeyMasked: maskKey(conf.apiKey || ''),
        },
      ])
    ),
  };
}

/**
 * Resolve the effective LLM config for an agent.
 * Merges: yaml defaults → yaml agent → settings.json agent overrides
 */
function resolveAgentLlm(yamlDefaults, yamlAgentLlm, agentName) {
  const override = getAgentConfig(agentName) || {};

  const merged = { ...yamlDefaults };

  // Apply yaml agent-level config
  if (yamlAgentLlm) {
    Object.assign(merged, yamlAgentLlm);
  }

  // Apply settings.json overrides (highest priority)
  if (override.llmType) merged.type = override.llmType;
  if (override.model)   merged.model = override.model;
  if (override.url)     merged.url = override.url;
  if (override.apiKey)  merged.api_key = override.apiKey;

  return merged;
}

/** Get the max concurrent projects setting */
function getMaxProjects() {
  const s = load();
  return s.maxProjects || 3;
}

/** Set the max concurrent projects */
function setMaxProjects(n) {
  const s = load();
  s.maxProjects = Math.max(1, Math.min(20, Number(n) || 3));
  save(s);
  return s.maxProjects;
}

module.exports = {
  load,
  save,
  maskKey,
  getGlobalKey,
  setGlobalKey,
  getAgentConfig,
  setAgentConfig,
  clearAgentConfig,
  getSafe,
  resolveAgentLlm,
  getMaxProjects,
  setMaxProjects,
};
