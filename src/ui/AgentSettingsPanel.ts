import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { SecretsManager } from '../config/SecretsManager';
import { AgentConfig, AgentCategory, ProviderType } from '../types';

type PanelMode = 'list' | 'new' | 'edit';

const AGENT_CATEGORIES: AgentCategory[] = [
  'Solution Architect Agent',
  'Data Architect Agent',
  'Business Analyst Agent',
  'Cloud Architect Agent',
  'Software QA / Testing Agent',
  'Front-End Designer Agent',
  'Advanced Coder Agent',
  'Custom Agent'
];

const PROVIDER_MODELS: Record<ProviderType, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o1-mini'],
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
  deepseek: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-coder-turbo']
};

export class AgentSettingsPanel {
  private static current: AgentSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly agentManager: AgentManager,
    private readonly secrets: SecretsManager,
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

    AgentSettingsPanel.current = new AgentSettingsPanel(panel, agentManager, secrets, mode);
  }

  private async sendAgentList(): Promise<void> {
    const agents = this.agentManager.listAgents();
    const agentsWithKeyStatus = await Promise.all(
      agents.map(async (a) => ({
        ...a,
        hasApiKey: await this.secrets.hasApiKey(a.id)
      }))
    );
    this.panel.webview.postMessage({
      type: 'agent_list',
      agents: agentsWithKeyStatus,
      mode: this.initialMode
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'get_agents':
        await this.sendAgentList();
        break;

      case 'save_agent': {
        const config = msg.config as AgentConfig;
        const apiKey = msg.apiKey as string | undefined;

        // Validate required fields
        if (!config.id || !config.name || !config.provider?.type || !config.provider?.model) {
          this.panel.webview.postMessage({
            type: 'error',
            message: 'Agent ID, Name, Provider, and Model are required.'
          });
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
          models: PROVIDER_MODELS[msg.provider as ProviderType] ?? []
        });
        break;

      case 'get_categories':
        this.panel.webview.postMessage({ type: 'categories', categories: AGENT_CATEGORIES });
        break;
    }
  }

  private getHtml(): string {
    const categoryOptions = AGENT_CATEGORIES
      .map(c => `<option value="${c}">${c}</option>`)
      .join('');

    const providerOptions = (Object.keys(PROVIDER_MODELS) as ProviderType[])
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
    input:focus, select:focus, textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    textarea { resize: vertical; min-height: 60px; }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 6px 16px; font-size: 13px; cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .row .btn { flex-shrink: 0; }
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
  </style>
</head>
<body>
  <h1>Bormagi — Agent Settings</h1>

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

    <label for="f-provider">Provider</label>
    <select id="f-provider" onchange="onProviderChange()">${providerOptions}</select>

    <label for="f-model">Model</label>
    <select id="f-model"></select>

    <label for="f-apikey">API Key</label>
    <input id="f-apikey" type="password" placeholder="sk-… (stored in encrypted VS Code secret storage)"/>
    <p class="hint">Leave blank to keep existing key. For Gemini with GCP SSO, set auth method to gcp_adc below.</p>

    <label for="f-auth-method">Auth Method (Gemini only)</label>
    <select id="f-auth-method">
      <option value="api_key">API Key</option>
      <option value="gcp_adc">GCP Application Default Credentials (SSO)</option>
    </select>

    <label for="f-base-url">Custom Base URL (optional)</label>
    <input id="f-base-url" type="text" placeholder="https://api.example.com/v1"/>

    <label for="f-proxy-url">Proxy URL (optional)</label>
    <input id="f-proxy-url" type="text" placeholder="https://proxy.example.com"/>

    <div class="row" style="margin-top:8px">
      <button class="btn" onclick="saveAgent()">Save Agent</button>
      <button class="btn btn-secondary" onclick="hideForm()">Cancel</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let agents = [];
    let editingId = null;

    // ── Provider model map ──────────────────────────────────────────────────
    const MODELS = ${JSON.stringify(PROVIDER_MODELS)};

    function onProviderChange() {
      const provider = document.getElementById('f-provider').value;
      const modelSel = document.getElementById('f-model');
      modelSel.innerHTML = (MODELS[provider] || []).map(m => '<option value="' + m + '">' + m + '</option>').join('');
    }

    // ── Agent list ──────────────────────────────────────────────────────────
    function renderAgentList() {
      const el = document.getElementById('agent-list');
      if (agents.length === 0) {
        el.innerHTML = '<p style="opacity:0.5">No agents configured yet.</p>';
        return;
      }
      el.innerHTML = agents.map(a => \`
        <div class="agent-item">
          <div class="agent-info">
            <div class="agent-name">@\${a.id} — \${a.name}</div>
            <div class="agent-meta">\${a.category} · \${a.provider?.type ?? '?'}/\${a.provider?.model ?? '?'} · API key: \${a.hasApiKey ? 'set' : 'NOT SET'}</div>
          </div>
          <div class="agent-actions">
            <button class="btn btn-secondary" onclick="showForm('\${a.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteAgent('\${a.id}')">Delete</button>
          </div>
        </div>
      \`).join('');
    }

    // ── Form ────────────────────────────────────────────────────────────────
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
          document.getElementById('f-provider').value = a.provider.type;
          onProviderChange();
          document.getElementById('f-model').value = a.provider.model;
          document.getElementById('f-auth-method').value = a.provider.auth_method;
          document.getElementById('f-base-url').value = a.provider.base_url || '';
          document.getElementById('f-proxy-url').value = a.provider.proxy_url || '';
          document.getElementById('f-apikey').value = '';
        }
      } else {
        document.getElementById('f-id').value = '';
        document.getElementById('f-id').readOnly = false;
        document.getElementById('f-name').value = '';
        document.getElementById('f-category').value = 'Custom Agent';
        document.getElementById('f-description').value = '';
        document.getElementById('f-provider').value = 'openai';
        onProviderChange();
        document.getElementById('f-auth-method').value = 'api_key';
        document.getElementById('f-base-url').value = '';
        document.getElementById('f-proxy-url').value = '';
        document.getElementById('f-apikey').value = '';
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
      const providerType = document.getElementById('f-provider').value;
      const model = document.getElementById('f-model').value;
      const authMethod = document.getElementById('f-auth-method').value;
      const baseUrl = document.getElementById('f-base-url').value.trim() || null;
      const proxyUrl = document.getElementById('f-proxy-url').value.trim() || null;
      const apiKey = document.getElementById('f-apikey').value;

      if (!id || !name || !providerType || !model) {
        showStatus('Agent ID, Name, Provider and Model are required.', false);
        return;
      }

      const config = {
        id, name, category, description, enabled: true,
        provider: { type: providerType, model, base_url: baseUrl, proxy_url: proxyUrl, auth_method: authMethod },
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

    // ── Messages from extension ─────────────────────────────────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'agent_list') {
        agents = msg.agents;
        renderAgentList();
        if (msg.mode === 'new') showForm(null);
      } else if (msg.type === 'save_success') {
        showStatus('Agent saved successfully.', true);
        hideForm();
      } else if (msg.type === 'error') {
        showStatus(msg.message, false);
      }
    });

    // Initial load
    onProviderChange();
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
