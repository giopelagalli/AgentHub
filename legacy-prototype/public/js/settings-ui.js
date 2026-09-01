// ============================================================
//  Settings UI — manage API keys + per-agent LLM config
// ============================================================

const SettingsUI = (() => {
  let agents = [];
  let currentSettings = null;

  const els = {};

  function init() {
    els.overlay      = document.getElementById('settingsOverlay');
    els.btnOpen      = document.getElementById('btnSettings');
    els.btnClose     = document.getElementById('btnCloseSettings');
    els.globalKey    = document.getElementById('settingsGlobalKey');
    els.btnToggle    = document.getElementById('btnToggleKeyVis');
    els.btnSave      = document.getElementById('btnSaveGlobalKey');
    els.globalStatus = document.getElementById('globalKeyStatus');
    els.agentList    = document.getElementById('agentSettingsList');

    els.btnOpen.addEventListener('click', open);
    els.btnClose.addEventListener('click', close);
    els.btnSave.addEventListener('click', saveGlobalKey);

    els.btnToggle.addEventListener('click', () => {
      const isPass = els.globalKey.type === 'password';
      els.globalKey.type = isPass ? 'text' : 'password';
      els.btnToggle.textContent = isPass ? 'Hide' : 'Show';
    });

    // Close on backdrop
    els.overlay.addEventListener('click', (e) => {
      if (e.target === els.overlay) close();
    });
  }

  async function open() {
    els.overlay.classList.remove('hidden');
    await loadSettings();
  }

  function close() {
    els.overlay.classList.add('hidden');
    // Reset key visibility
    els.globalKey.type = 'password';
    els.btnToggle.textContent = 'Show';
  }

  function updateAgents(agentList) {
    agents = agentList;
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      currentSettings = await res.json();
      render();
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  function render() {
    if (!currentSettings) return;

    // Global key field — show masked placeholder
    els.globalKey.value = '';
    if (currentSettings.hasGlobalKey) {
      els.globalKey.placeholder = `Current: ${currentSettings.globalApiKey}`;
      els.globalStatus.textContent = 'Key is set';
      els.globalStatus.className = 'settings-status ok';
    } else {
      els.globalKey.placeholder = 'No key set — paste your key here';
      els.globalStatus.textContent = 'No key configured';
      els.globalStatus.className = 'settings-status err';
    }

    // Per-agent cards
    renderAgentCards();
  }

  function renderAgentCards() {
    els.agentList.innerHTML = '';

    for (const agent of agents) {
      const override = currentSettings.agents[agent.name] || {};
      const hasOverride = override.llmType || override.hasCustomKey || override.model || override.url;

      const card = document.createElement('div');
      card.className = `agent-settings-card${hasOverride ? ' modified' : ''}`;

      card.innerHTML = `
        <div class="agent-card-header">
          <span class="agent-card-name">${agent.name}</span>
          <span class="agent-card-role">${agent.role}</span>
        </div>
        <div class="agent-card-fields">
          <div class="agent-card-field">
            <label>Provider</label>
            <select class="pixel-select" data-field="llmType">
              <option value="">Default (anthropic)</option>
              <option value="anthropic" ${override.llmType === 'anthropic' ? 'selected' : ''}>Anthropic</option>
              <option value="ollama" ${override.llmType === 'ollama' ? 'selected' : ''}>Ollama (local)</option>
              <option value="openai-compatible" ${override.llmType === 'openai-compatible' ? 'selected' : ''}>OpenAI-compatible</option>
            </select>
          </div>
          <div class="agent-card-field">
            <label>Model</label>
            <input class="pixel-input" data-field="model"
                   placeholder="${agent.llmModel || 'default'}"
                   value="${override.model || ''}" />
          </div>
          <div class="agent-card-field">
            <label>API Key (leave blank = global)</label>
            <input class="pixel-input" data-field="apiKey" type="password"
                   placeholder="${override.hasCustomKey ? override.apiKeyMasked : 'Uses global key'}"
                   value="" autocomplete="off" />
          </div>
          <div class="agent-card-field">
            <label>Endpoint URL</label>
            <input class="pixel-input" data-field="url"
                   placeholder="${override.url || 'default'}"
                   value="${override.url || ''}" />
          </div>
        </div>
        <div class="agent-card-actions">
          ${hasOverride ? `<button class="pixel-btn small" data-action="reset">Reset to default</button>` : ''}
          <button class="pixel-btn small" data-action="save">Save</button>
        </div>
      `;

      // Wire buttons
      card.querySelector('[data-action="save"]').addEventListener('click', () => {
        saveAgentConfig(agent.name, card);
      });

      const resetBtn = card.querySelector('[data-action="reset"]');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => resetAgentConfig(agent.name));
      }

      els.agentList.appendChild(card);
    }
  }

  async function saveGlobalKey() {
    const key = els.globalKey.value.trim();
    if (!key) {
      els.globalStatus.textContent = 'Enter a key first';
      els.globalStatus.className = 'settings-status err';
      return;
    }

    els.btnSave.disabled = true;
    els.btnSave.textContent = '...';

    try {
      const res = await fetch('/api/settings/global-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });

      const data = await res.json();

      if (res.ok) {
        els.globalStatus.textContent = `Key saved: ${data.masked}`;
        els.globalStatus.className = 'settings-status ok';
        els.globalKey.value = '';
        await loadSettings(); // refresh
      } else {
        els.globalStatus.textContent = data.error || 'Failed to save';
        els.globalStatus.className = 'settings-status err';
      }
    } catch (err) {
      els.globalStatus.textContent = `Error: ${err.message}`;
      els.globalStatus.className = 'settings-status err';
    }

    els.btnSave.disabled = false;
    els.btnSave.textContent = 'Save';
  }

  async function saveAgentConfig(agentName, card) {
    const fields = {};

    const llmType = card.querySelector('[data-field="llmType"]').value;
    const model   = card.querySelector('[data-field="model"]').value.trim();
    const apiKey  = card.querySelector('[data-field="apiKey"]').value.trim();
    const url     = card.querySelector('[data-field="url"]').value.trim();

    if (llmType) fields.llmType = llmType;
    if (model)   fields.model = model;
    if (apiKey)  fields.apiKey = apiKey;
    if (url)     fields.url = url;

    try {
      const res = await fetch(`/api/settings/agents/${encodeURIComponent(agentName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });

      if (res.ok) {
        await loadSettings(); // refresh cards
      } else {
        const data = await res.json();
        console.error(`Failed to save ${agentName}:`, data.error);
      }
    } catch (err) {
      console.error(`Error saving ${agentName}:`, err);
    }
  }

  async function resetAgentConfig(agentName) {
    try {
      await fetch(`/api/settings/agents/${encodeURIComponent(agentName)}`, {
        method: 'DELETE',
      });
      await loadSettings();
    } catch (err) {
      console.error(`Error resetting ${agentName}:`, err);
    }
  }

  return { init, open, close, updateAgents };
})();
