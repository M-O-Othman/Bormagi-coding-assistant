import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { SecretsManager } from '../config/SecretsManager';
import { ConfigManager } from '../config/ConfigManager';
import { AgentConfig, AgentCategory, ProviderConfig, ProviderType } from '../types';
import { getAppData } from '../data/DataStore';

type PanelMode = 'list' | 'new' | 'edit';

export class AgentSettingsPanel {
  private static current: AgentSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly agentManager: AgentManager,
    private readonly secrets: SecretsManager,
    private readonly configManager: ConfigManager,
    private initialMode: PanelMode
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data
    void this.sendAgentList();
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    agentManager: AgentManager,
    secrets: SecretsManager,
    configManager: ConfigManager,
    mode: PanelMode = 'list'
  ): void {
    if (AgentSettingsPanel.current) {
      AgentSettingsPanel.current.panel.reveal(vscode.ViewColumn.One);
      AgentSettingsPanel.current.initialMode = mode;
      void AgentSettingsPanel.current.sendAgentList();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'bormagiSettings',
      'Bormagi — Agent Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    AgentSettingsPanel.current = new AgentSettingsPanel(panel, agentManager, secrets, configManager, mode);
  }

  private async sendAgentList(): Promise<void> {
    const agents = this.agentManager.listAgents();
    const agentsWithKeyStatus = await Promise.all(
      agents.map(async (a) => ({
        ...a,
        hasApiKey: await this.secrets.hasApiKey(a.id)
      }))
    );
    const defaultProvider = await this.configManager.readDefaultProvider();
    const hasDefaultKey = await this.secrets.hasApiKey('__default__');
    this.panel.webview.postMessage({
      type: 'agent_list',
      agents: agentsWithKeyStatus,
      mode: this.initialMode,
      defaultProvider: defaultProvider ?? null,
      hasDefaultKey
    });
  }

  private normaliseAuthMethod(provider: ProviderConfig): ProviderConfig {
    if (provider.type !== 'gemini') {
      return { ...provider, auth_method: 'api_key' };
    }
    if (provider.auth_method === 'gcp_adc') {
      return { ...provider, auth_method: 'vertex_ai' };
    }
    return provider;
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'get_agents':
        await this.sendAgentList();
        break;

      case 'save_agent': {
        const config = msg.config as AgentConfig;
        config.provider = this.normaliseAuthMethod(config.provider);
        const apiKey = msg.apiKey as string | undefined;

        if (!config.id || !config.name) {
          this.panel.webview.postMessage({ type: 'error', message: 'Agent ID and Name are required.' });
          return;
        }
        if (!config.useDefaultProvider && (!config.provider?.type || !config.provider?.model)) {
          this.panel.webview.postMessage({ type: 'error', message: 'Provider and Model are required unless "Use workspace default" is checked.' });
          return;
        }

        const existing = this.agentManager.getAgent(config.id);
        if (existing) {
          await this.agentManager.updateAgent(config);
        } else {
          await this.agentManager.createAgent(config);
        }

        if (apiKey && apiKey.trim()) {
          await this.secrets.setApiKey(config.id, apiKey.trim());
        }

        this.panel.webview.postMessage({ type: 'save_success', agentId: config.id });
        await this.sendAgentList();
        break;
      }

      case 'delete_agent': {
        const agentId = msg.agentId as string;
        const confirm = await vscode.window.showWarningMessage(
          `Delete agent "${agentId}"? This will remove all its configuration files.`,
          { modal: true },
          'Delete',
          'Cancel'
        );
        if (confirm === 'Delete') {
          await this.agentManager.deleteAgent(agentId);
          await this.secrets.deleteApiKey(agentId);
          await this.sendAgentList();
        }
        break;
      }

      case 'get_models':
        this.panel.webview.postMessage({
          type: 'models',
          provider: msg.provider as string,
          models: getAppData().providerModels[msg.provider as ProviderType] ?? []
        });
        break;

      case 'get_categories':
        this.panel.webview.postMessage({ type: 'categories', categories: getAppData().agentCategories });
        break;

      case 'save_default_provider': {
        const provider = this.normaliseAuthMethod(msg.provider as ProviderConfig);
        const apiKey = msg.apiKey as string | undefined;
        if (!provider?.type || !provider?.model) {
          this.panel.webview.postMessage({ type: 'error', message: 'Provider type and model are required for the default provider.' });
          return;
        }
        await this.configManager.writeDefaultProvider(provider);
        if (apiKey && apiKey.trim()) {
          await this.secrets.setApiKey('__default__', apiKey.trim());
        }
        this.panel.webview.postMessage({ type: 'default_saved' });
        await this.sendAgentList();
        break;
      }

      case 'apply_default_to_all': {
        // Set useDefaultProvider: true for every agent so they all use the workspace default
        const allAgents = this.agentManager.listAgents();
        for (const a of allAgents) {
          await this.agentManager.updateAgent({ ...a, useDefaultProvider: true });
        }
        this.panel.webview.postMessage({ type: 'apply_default_done', count: allAgents.length });
        await this.sendAgentList();
        break;
      }
    }
  }

  private getHtml(): string {
    const { agentCategories, providerModels } = getAppData();
    const categoryOptions = agentCategories
      .map(c => `<option value="${c}">${c}</option>`)
      .join('');

    const providerOptions = (Object.keys(providerModels) as ProviderType[])
      .map(p => `<option value="${p}">${p}</option>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
  <title>Bormagi — Agent Settings</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    h1 { font-size: 18px; margin-bottom: 18px; font-weight: 600; }
    h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    .section { margin-bottom: 28px; }
    label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; opacity: 0.75; }
    input, select, textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 13px;
      margin-bottom: 12px;
    }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    textarea { resize: vertical; min-height: 60px; }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 6px 16px; font-size: 13px; cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    #agent-list { display: flex; flex-direction: column; gap: 8px; }
    .agent-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
    }
    .agent-info { flex: 1; }
    .agent-name { font-weight: 600; font-size: 13px; }
    .agent-meta { font-size: 11px; opacity: 0.6; margin-top: 2px; }
    .agent-actions { display: flex; gap: 6px; }
    #form-panel { display: none; }
    #form-panel.visible { display: block; }
    .error-msg { color: var(--vscode-errorForeground); font-size: 12px; margin-bottom: 10px; }
    .success-msg { color: var(--vscode-terminal-ansiGreen); font-size: 12px; margin-bottom: 10px; }
    .hint { font-size: 11px; opacity: 0.5; margin-top: -8px; margin-bottom: 12px; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 18px 0; }
    .default-card {
      padding: 12px 14px;
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      margin-bottom: 20px;
    }
    .default-card h3 { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
    .default-card .badge {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 1px 6px; border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      text-transform: uppercase; letter-spacing: 0.5px;
      margin-left: 6px; vertical-align: middle;
    }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .checkbox-row input[type=checkbox] { width: auto; margin-bottom: 0; }
    .checkbox-row label { margin-bottom: 0; opacity: 1; }
    #default-status { font-size: 12px; margin-top: 8px; min-height: 16px; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <h1>Bormagi — Agent Settings</h1>

  <!-- Default Provider Card -->
  <div class="default-card">
    <h3>Workspace Default Provider</h3>
    <p style="font-size:11px;opacity:0.6;margin-bottom:10px">
      Set one provider + API key here, then click <strong>Apply to all agents</strong> to switch every agent to this provider instantly.
      Individual agents can still override this in their own settings.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div>
        <label for="dp-provider">Provider</label>
        <select id="dp-provider" onchange="onDefaultProviderChange()">${providerOptions}</select>
      </div>
      <div>
        <label for="dp-model">Model</label>
        <select id="dp-model"></select>
      </div>
    </div>
    <label for="dp-apikey">API Key</label>
    <input id="dp-apikey" type="password" placeholder="Leave blank to keep existing key"/>
    <label for="dp-base-url">Custom Base URL (optional)</label>
    <input id="dp-base-url" type="text" placeholder="https://api.example.com/v1beta"/>
    <label for="dp-proxy-url">Proxy URL (optional)</label>
    <input id="dp-proxy-url" type="text" placeholder="https://proxy.example.com"/>
    <label for="dp-auth">Auth Method (Gemini only)</label>
    <select id="dp-auth" onchange="syncDefaultAuthControls()">
      <option value="api_key">API Key</option>
      <option value="oauth_proxy">OAuth Identity via Proxy (no API key)</option>
      <option value="vertex_ai">GCP Vertex AI (ADC/OAuth)</option>
    </select>
    <div id="dp-vertex-location-row" style="display:none">
      <label for="dp-vertex-location">Vertex AI Region</label>
      <input id="dp-vertex-location" type="text" placeholder="europe-west4"/>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" onclick="saveDefaultProvider()">Save Default Provider</button>
      <button class="btn btn-secondary" onclick="applyDefaultToAll()" title="Set all agents to use the workspace default provider">Apply to all agents</button>
    </div>
    <div id="default-status"></div>
  </div>

  <div class="section" id="list-section">
    <h2>Configured Agents</h2>
    <div id="agent-list"><p style="opacity:0.5">Loading…</p></div>
    <br/>
    <button class="btn" onclick="showForm(null)">+ New Agent</button>
  </div>

  <hr/>

  <div id="form-panel">
    <h2 id="form-title">New Agent</h2>
    <div id="status-msg"></div>

    <label for="f-id">Agent ID (used for @mention, no spaces)</label>
    <input id="f-id" type="text" placeholder="advanced-coder"/>

    <label for="f-name">Display Name</label>
    <input id="f-name" type="text" placeholder="Advanced Coder"/>

    <label for="f-category">Category</label>
    <select id="f-category">${categoryOptions}</select>

    <label for="f-description">Description</label>
    <textarea id="f-description" rows="3" placeholder="Describe what this agent does…"></textarea>

    <hr/>
    <h2>LLM Provider</h2>

    <div class="checkbox-row">
      <input type="checkbox" id="f-use-default" onchange="onUseDefaultChange()"/>
      <label for="f-use-default">Use workspace default provider</label>
    </div>

    <div id="f-provider-fields">
      <label for="f-provider">Provider</label>
      <select id="f-provider" onchange="onProviderChange()">${providerOptions}</select>

      <label for="f-model">Model</label>
      <select id="f-model"></select>

      <label for="f-apikey">API Key</label>
      <input id="f-apikey" type="password" placeholder="sk-… (stored in encrypted VS Code secret storage)"/>
      <p class="hint" id="f-auth-hint">Leave blank to keep existing key. For Gemini OAuth/Vertex modes, API key is not required.</p>

      <label for="f-auth-method">Auth Method (Gemini only)</label>
      <select id="f-auth-method">
        <option value="api_key">API Key</option>
        <option value="oauth_proxy">OAuth Identity via Proxy (no API key)</option>
        <option value="vertex_ai">GCP Vertex AI (ADC/OAuth)</option>
      </select>

      <label for="f-base-url">Custom Base URL (optional)</label>
      <input id="f-base-url" type="text" placeholder="https://api.example.com/v1"/>

      <label for="f-proxy-url">Proxy URL (optional)</label>
      <input id="f-proxy-url" type="text" placeholder="https://proxy.example.com"/>

      <div id="f-vertex-location-row" style="display:none">
        <label for="f-vertex-location">Vertex AI Region</label>
        <input id="f-vertex-location" type="text" placeholder="europe-west4"/>
      </div>
    </div>

    <div class="row" style="margin-top:8px">
      <button class="btn" onclick="saveAgent()">Save Agent</button>
      <button class="btn btn-secondary" onclick="hideForm()">Cancel</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let agents = [];
    let editingId = null;

    const MODELS = ${JSON.stringify(getAppData().providerModels)};

    function normaliseAuthMethod(raw) {
      return raw === 'gcp_adc' ? 'vertex_ai' : raw;
    }

    function syncDefaultAuthControls() {
      const provider = document.getElementById('dp-provider').value;
      const isGemini = provider === 'gemini';
      const authSel = document.getElementById('dp-auth');
      authSel.disabled = !isGemini;
      if (!isGemini) authSel.value = 'api_key';
      const isVertex = isGemini && authSel.value === 'vertex_ai';
      document.getElementById('dp-vertex-location-row').style.display = isVertex ? '' : 'none';
    }

    function syncAgentAuthControls() {
      const provider = document.getElementById('f-provider').value;
      const isGemini = provider === 'gemini';
      const authSel = document.getElementById('f-auth-method');
      const hint = document.getElementById('f-auth-hint');
      authSel.disabled = !isGemini;
      if (!isGemini) authSel.value = 'api_key';
      if (isGemini && authSel.value !== 'api_key') {
        hint.textContent = 'OAuth/Vertex mode selected: API key is optional.';
      } else {
        hint.textContent = 'Leave blank to keep existing key. For Gemini OAuth/Vertex modes, API key is not required.';
      }
      const isVertex = isGemini && authSel.value === 'vertex_ai';
      document.getElementById('f-vertex-location-row').style.display = isVertex ? '' : 'none';
    }

    // ── Default provider section ───────────────────────────────────────────
    function onDefaultProviderChange() {
      const p = document.getElementById('dp-provider').value;
      const sel = document.getElementById('dp-model');
      sel.innerHTML = (MODELS[p] || []).map(m => '<option value="' + m + '">' + m + '</option>').join('');
      syncDefaultAuthControls();
    }

    function saveDefaultProvider() {
      const type = document.getElementById('dp-provider').value;
      const model = document.getElementById('dp-model').value;
      const authMethod = type === 'gemini' ? normaliseAuthMethod(document.getElementById('dp-auth').value) : 'api_key';
      const apiKey = document.getElementById('dp-apikey').value.trim();
      const baseUrl = document.getElementById('dp-base-url').value.trim() || null;
      const proxyUrl = document.getElementById('dp-proxy-url').value.trim() || null;
      const vertexLocation = document.getElementById('dp-vertex-location').value.trim() || null;
      vscode.postMessage({
        type: 'save_default_provider',
        provider: { type, model, base_url: baseUrl, proxy_url: proxyUrl, auth_method: authMethod, vertex_location: vertexLocation },
        apiKey: apiKey || undefined
      });
    }

    function applyDefaultToAll() {
      const type = document.getElementById('dp-provider').value;
      const model = document.getElementById('dp-model').value;
      if (!type || !model) {
        document.getElementById('default-status').textContent = '⚠ Save the default provider first.';
        return;
      }
      document.getElementById('default-status').textContent = 'Applying…';
      vscode.postMessage({ type: 'apply_default_to_all' });
    }

    // ── Per-agent provider fields toggle ──────────────────────────────────
    function onUseDefaultChange() {
      const useDefault = document.getElementById('f-use-default').checked;
      document.getElementById('f-provider-fields').style.opacity = useDefault ? '0.35' : '1';
      document.getElementById('f-provider-fields').style.pointerEvents = useDefault ? 'none' : '';
    }

    function onProviderChange() {
      const provider = document.getElementById('f-provider').value;
      const modelSel = document.getElementById('f-model');
      modelSel.innerHTML = (MODELS[provider] || []).map(m => '<option value="' + m + '">' + m + '</option>').join('');
      syncAgentAuthControls();
    }

    // ── Agent list ─────────────────────────────────────────────────────────
    function renderAgentList() {
      const el = document.getElementById('agent-list');
      if (agents.length === 0) {
        el.innerHTML = '<p style="opacity:0.5">No agents configured yet.</p>';
        return;
      }
      el.innerHTML = agents.map(a => {
        const providerLabel = a.useDefaultProvider
          ? '<em>workspace default</em>'
          : ((a.provider?.type ?? '?') + '/' + (a.provider?.model ?? '?'));
        return \`
        <div class="agent-item">
          <div class="agent-info">
            <div class="agent-name">@\${a.id} — \${a.name}</div>
            <div class="agent-meta">\${a.category} · \${providerLabel} · API key: \${a.hasApiKey ? 'set' : 'NOT SET'}</div>
          </div>
          <div class="agent-actions">
            <button class="btn btn-secondary" onclick="showForm('\${a.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteAgent('\${a.id}')">Delete</button>
          </div>
        </div>\`;
      }).join('');
    }

    // ── Agent form ─────────────────────────────────────────────────────────
    function showForm(agentId) {
      editingId = agentId;
      const panel = document.getElementById('form-panel');
      panel.classList.add('visible');
      document.getElementById('form-title').textContent = agentId ? 'Edit Agent' : 'New Agent';
      document.getElementById('status-msg').textContent = '';

      if (agentId) {
        const a = agents.find(x => x.id === agentId);
        if (a) {
          document.getElementById('f-id').value = a.id;
          document.getElementById('f-id').readOnly = true;
          document.getElementById('f-name').value = a.name;
          document.getElementById('f-category').value = a.category;
          document.getElementById('f-description').value = a.description;
          document.getElementById('f-use-default').checked = !!a.useDefaultProvider;
          document.getElementById('f-provider').value = a.provider.type;
          onProviderChange();
          document.getElementById('f-model').value = a.provider.model;
          document.getElementById('f-auth-method').value = normaliseAuthMethod(a.provider.auth_method || 'api_key');
          document.getElementById('f-base-url').value = a.provider.base_url || '';
          document.getElementById('f-proxy-url').value = a.provider.proxy_url || '';
          document.getElementById('f-vertex-location').value = a.provider.vertex_location || '';
          document.getElementById('f-apikey').value = '';
          syncAgentAuthControls();
          onUseDefaultChange();
        }
      } else {
        document.getElementById('f-id').value = '';
        document.getElementById('f-id').readOnly = false;
        document.getElementById('f-name').value = '';
        document.getElementById('f-category').value = 'Custom Agent';
        document.getElementById('f-description').value = '';
        document.getElementById('f-use-default').checked = false;
        document.getElementById('f-provider').value = 'anthropic';
        onProviderChange();
        document.getElementById('f-auth-method').value = 'api_key';
        document.getElementById('f-base-url').value = '';
        document.getElementById('f-proxy-url').value = '';
        document.getElementById('f-vertex-location').value = '';
        document.getElementById('f-apikey').value = '';
        syncAgentAuthControls();
        onUseDefaultChange();
      }
      panel.scrollIntoView({ behavior: 'smooth' });
    }

    function hideForm() {
      document.getElementById('form-panel').classList.remove('visible');
      editingId = null;
    }

    function saveAgent() {
      const id = document.getElementById('f-id').value.trim().toLowerCase().replace(/\\s+/g, '-');
      const name = document.getElementById('f-name').value.trim();
      const category = document.getElementById('f-category').value;
      const description = document.getElementById('f-description').value.trim();
      const useDefaultProvider = document.getElementById('f-use-default').checked;
      const providerType = document.getElementById('f-provider').value;
      const model = document.getElementById('f-model').value;
      const authMethod = providerType === 'gemini'
        ? normaliseAuthMethod(document.getElementById('f-auth-method').value)
        : 'api_key';
      const baseUrl = document.getElementById('f-base-url').value.trim() || null;
      const proxyUrl = document.getElementById('f-proxy-url').value.trim() || null;
      const vertexLocation = document.getElementById('f-vertex-location').value.trim() || null;
      const apiKey = document.getElementById('f-apikey').value;

      if (!id || !name) {
        showStatus('Agent ID and Name are required.', false);
        return;
      }

      const config = {
        id, name, category, description, enabled: true,
        useDefaultProvider,
        provider: { type: providerType, model, base_url: baseUrl, proxy_url: proxyUrl, auth_method: authMethod, vertex_location: vertexLocation },
        system_prompt_files: ['system-prompt.md'],
        mcp_servers: [],
        context_filter: {
          include_extensions: ['.ts','.tsx','.js','.jsx','.py','.java','.cs','.go','.rs','.html','.css','.md','.txt','.json','.yaml','.yml','.sql','.csv','.tsv'],
          exclude_patterns: ['node_modules','dist','.git','build','__pycache__','.bormagi']
        }
      };

      vscode.postMessage({ type: 'save_agent', config, apiKey: apiKey || undefined });
    }

    function deleteAgent(agentId) {
      vscode.postMessage({ type: 'delete_agent', agentId });
    }

    function showStatus(msg, success) {
      const el = document.getElementById('status-msg');
      el.className = success ? 'success-msg' : 'error-msg';
      el.textContent = msg;
    }

    // ── Messages from extension ────────────────────────────────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'agent_list') {
        agents = msg.agents;
        renderAgentList();
        if (msg.mode === 'new') showForm(null);
        // Populate default provider fields
        if (msg.defaultProvider) {
          document.getElementById('dp-provider').value = msg.defaultProvider.type;
          onDefaultProviderChange();
          document.getElementById('dp-model').value = msg.defaultProvider.model;
          document.getElementById('dp-auth').value = normaliseAuthMethod(msg.defaultProvider.auth_method || 'api_key');
          document.getElementById('dp-base-url').value = msg.defaultProvider.base_url || '';
          document.getElementById('dp-proxy-url').value = msg.defaultProvider.proxy_url || '';
          document.getElementById('dp-vertex-location').value = msg.defaultProvider.vertex_location || '';
          syncDefaultAuthControls();
        }
        document.getElementById('default-status').textContent =
          msg.hasDefaultKey ? '✓ Default API key is set' : 'No default API key set';
        document.getElementById('default-status').style.opacity = '0.6';
      } else if (msg.type === 'save_success') {
        showStatus('Agent saved successfully.', true);
        hideForm();
      } else if (msg.type === 'default_saved') {
        document.getElementById('default-status').textContent = '✓ Default provider saved';
        document.getElementById('default-status').style.color = 'var(--vscode-terminal-ansiGreen)';
        document.getElementById('dp-apikey').value = '';
      } else if (msg.type === 'apply_default_done') {
        document.getElementById('default-status').textContent = '✓ Applied to ' + msg.count + ' agent(s). Refresh the chat sidebar to see changes.';
        document.getElementById('default-status').style.color = 'var(--vscode-terminal-ansiGreen)';
      } else if (msg.type === 'error') {
        showStatus(msg.message, false);
      }
    });

    // Initial load
    onDefaultProviderChange();
    onProviderChange();
    document.getElementById('f-auth-method').addEventListener('change', syncAgentAuthControls);
    vscode.postMessage({ type: 'get_agents' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    AgentSettingsPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
