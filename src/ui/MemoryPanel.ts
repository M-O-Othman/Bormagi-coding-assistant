import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { MemoryManager } from '../agents/MemoryManager';

export class MemoryPanel {
    private static current: MemoryPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly agentManager: AgentManager,
        private readonly memoryManager: MemoryManager
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => this.handleMessage(msg),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        void this.sendAgentList();
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        agentManager: AgentManager,
        memoryManager: MemoryManager
    ): void {
        if (MemoryPanel.current) {
            MemoryPanel.current.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'bormagiMemory',
            'Bormagi — Memory Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        MemoryPanel.current = new MemoryPanel(panel, agentManager, memoryManager);
    }

    private async sendAgentList(): Promise<void> {
        const agents = this.agentManager.listAgents()
            .map(a => ({ id: a.id, name: a.name }));
        this.panel.webview.postMessage({ type: 'agent_list', agents });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'get_memory': {
                const agentId = msg.agentId as string;
                const sessionFacts = this.memoryManager.sessionMemory.getFacts(agentId);
                const publishedEntries = this.memoryManager.publishedKnowledge.getEntries(agentId);

                this.panel.webview.postMessage({
                    type: 'memory_data',
                    agentId,
                    sessionFacts,
                    publishedEntries
                });
                break;
            }
            case 'clear_session': {
                const agentId = msg.agentId as string;
                this.memoryManager.clearSession(agentId);

                const sessionFacts = this.memoryManager.sessionMemory.getFacts(agentId);
                const publishedEntries = this.memoryManager.publishedKnowledge.getEntries(agentId);
                this.panel.webview.postMessage({
                    type: 'memory_data',
                    agentId,
                    sessionFacts,
                    publishedEntries
                });
                break;
            }
            case 'reset_published': {
                const agentId = msg.agentId as string;
                this.memoryManager.resetPublishedKnowledge(agentId);

                const sessionFacts = this.memoryManager.sessionMemory.getFacts(agentId);
                const publishedEntries = this.memoryManager.publishedKnowledge.getEntries(agentId);
                this.panel.webview.postMessage({
                    type: 'memory_data',
                    agentId,
                    sessionFacts,
                    publishedEntries
                });
                break;
            }
            case 'delete_published': {
                const agentId = msg.agentId as string;
                const entryId = msg.entryId as string;
                this.memoryManager.publishedKnowledge.deleteEntry(agentId, entryId);

                const sessionFacts = this.memoryManager.sessionMemory.getFacts(agentId);
                const publishedEntries = this.memoryManager.publishedKnowledge.getEntries(agentId);
                this.panel.webview.postMessage({
                    type: 'memory_data',
                    agentId,
                    sessionFacts,
                    publishedEntries
                });
                break;
            }
            case 'force_promote': {
                const agentId = msg.agentId as string;
                const factId = msg.factId as string;
                const facts = this.memoryManager.sessionMemory.getFacts(agentId);
                const fact = facts.find(f => f.factId === factId);
                if (fact) {
                    const session = this.memoryManager.sessionMemory.getOrCreateSession(agentId);
                    this.memoryManager.publishedKnowledge.promote(agentId, fact, "Manual User Promotion", session.sessionId);
                }

                const sessionFacts = this.memoryManager.sessionMemory.getFacts(agentId);
                const publishedEntries = this.memoryManager.publishedKnowledge.getEntries(agentId);
                this.panel.webview.postMessage({
                    type: 'memory_data',
                    agentId,
                    sessionFacts,
                    publishedEntries
                });
                break;
            }
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
  <title>Memory Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    h1 { font-size: 18px; margin-bottom: 8px; font-weight: 600; }
    h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    p.desc { opacity: 0.7; margin-bottom: 20px; font-size: 12px; }
    
    label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; opacity: 0.75; }
    select {
      width: 100%; max-width: 400px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      padding: 6px 8px; font-size: 13px; margin-bottom: 24px;
    }
    
    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border, #444); margin-bottom: 16px; }
    .tab { 
      padding: 8px 16px; cursor: pointer; opacity: 0.6; 
      border-bottom: 2px solid transparent; font-weight: 600; font-size: 13px;
    }
    .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 4px 12px; font-size: 12px; cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    
    .fact-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px; padding: 12px; margin-bottom: 12px;
      display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
    }
    .fact-content { flex: 1; }
    .fact-text { font-size: 13px; margin-bottom: 6px; line-height: 1.4; }
    .fact-meta { font-size: 11px; opacity: 0.6; display: flex; gap: 12px; }
    .fact-badge { 
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase;
    }
    
    .header-actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .empty-state { padding: 32px; text-align: center; opacity: 0.5; font-style: italic; }
  </style>
</head>
<body>
  <h1>Agent Memory Manager</h1>
  <p class="desc">Inspect and manage semantic facts extracted during sessions (Tier 2) and durable published knowledge (Tier 3).</p>

  <label for="agent-select">Select Agent</label>
  <select id="agent-select" onchange="onAgentChanged()">
    <option value="">Loading...</option>
  </select>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('session')">Session Memory (Tier 2)</div>
    <div class="tab" onclick="switchTab('published')">Published Knowledge (Tier 3)</div>
  </div>

  <div id="tab-session" class="tab-content active">
    <div class="header-actions">
      <p style="font-size:12px; opacity:0.8;">Facts automatically extracted from the current active session.</p>
      <button class="btn btn-warning" onclick="clearSession()">Clear Session</button>
    </div>
    <div id="session-list"></div>
  </div>

  <div id="tab-published" class="tab-content">
    <div class="header-actions">
      <p style="font-size:12px; opacity:0.8;">Facts promoted to long-term durable memory across all sessions.</p>
      <button class="btn btn-danger" onclick="resetPublished()">Reset All Published Knowledge</button>
    </div>
    <div id="published-list"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function switchTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    function onAgentChanged() {
      const agentId = document.getElementById('agent-select').value;
      if (agentId) {
        vscode.postMessage({ type: 'get_memory', agentId });
      }
    }

    function clearSession() {
      const agentId = document.getElementById('agent-select').value;
      if (agentId && confirm("Clear all facts for this session?")) {
        vscode.postMessage({ type: 'clear_session', agentId });
      }
    }

    function resetPublished() {
      const agentId = document.getElementById('agent-select').value;
      if (agentId && confirm("WARNING: This will permanently delete all long-term knowledge for this agent. Proceed?")) {
        vscode.postMessage({ type: 'reset_published', agentId });
      }
    }

    function forcePromote(factId) {
      const agentId = document.getElementById('agent-select').value;
      if (agentId) {
        vscode.postMessage({ type: 'force_promote', agentId, factId });
      }
    }

    function deletePublished(entryId) {
      const agentId = document.getElementById('agent-select').value;
      if (agentId && confirm("Delete this published fact?")) {
        vscode.postMessage({ type: 'delete_published', agentId, entryId });
      }
    }

    function renderSessionList(facts) {
      const el = document.getElementById('session-list');
      if (!facts || facts.length === 0) {
        el.innerHTML = '<div class="empty-state">No facts extracted in the current session.</div>';
        return;
      }
      
      el.innerHTML = facts.map(f => \`
        <div class="fact-card">
          <div class="fact-content">
            <div class="fact-text">\${f.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            <div class="fact-meta">
              <span class="fact-badge">\${f.factType}</span>
              <span>Conf: \${(f.confidence * 100).toFixed(0)}%</span>
              <span>Origin: \${f.origin}</span>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="forcePromote('\${f.factId}')" title="Promote to Tier 3 immediately">Promote</button>
        </div>
      \`).reverse().join('');
    }

    function renderPublishedList(entries) {
      const el = document.getElementById('published-list');
      if (!entries || entries.length === 0) {
        el.innerHTML = '<div class="empty-state">No published knowledge found.</div>';
        return;
      }

      el.innerHTML = entries.map(e => \`
        <div class="fact-card">
          <div class="fact-content">
            <div class="fact-text">\${e.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            <div class="fact-meta">
              <span class="fact-badge">\${e.factType}</span>
              <span>Promoted: \${new Date(e.promotedAt).toLocaleString()}</span>
              <span>Rule: \${e.promotionRule}</span>
            </div>
          </div>
          <button class="btn btn-danger" onclick="deletePublished('\${e.id}')">Delete</button>
        </div>
      \`).reverse().join('');
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'agent_list') {
        const sel = document.getElementById('agent-select');
        sel.innerHTML = msg.agents.map(a => \`<option value="\${a.id}">@\${a.id} (\${a.name})</option>\`).join('');
        if (msg.agents.length > 0) onAgentChanged();
      } else if (msg.type === 'memory_data') {
        const currentAgent = document.getElementById('agent-select').value;
        if (msg.agentId === currentAgent) {
          renderSessionList(msg.sessionFacts);
          renderPublishedList(msg.publishedEntries);
        }
      }
    });

  </script>
</body>
</html>`;
    }

    dispose(): void {
        MemoryPanel.current = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
