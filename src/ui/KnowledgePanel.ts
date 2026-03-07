import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { KnowledgeManager } from '../knowledge/KnowledgeManager';
import { RetrievalService } from '../knowledge/RetrievalService';

export class KnowledgePanel {
  private static current: KnowledgePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly agentManager: AgentManager,
    private readonly knowledgeManager: KnowledgeManager,
    private readonly workspaceRoot: string
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Initial data load
    void this.sendAgentList();
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    agentManager: AgentManager,
    knowledgeManager: KnowledgeManager,
    workspaceRoot: string
  ): void {
    if (KnowledgePanel.current) {
      KnowledgePanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'bormagiKnowledge',
      'Bormagi — Knowledge Base Manager',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    KnowledgePanel.current = new KnowledgePanel(panel, agentManager, knowledgeManager, workspaceRoot);
  }

  private async sendAgentList(): Promise<void> {
    const agents = this.agentManager.listAgents()
      .filter(a => a.knowledge && a.knowledge.source_folders && a.knowledge.source_folders.length > 0)
      .map(a => ({ id: a.id, name: a.name, folders: a.knowledge!.source_folders }));
    this.panel.webview.postMessage({ type: 'agent_list', agents });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'get_stats': {
        const agentId = msg.agentId as string;
        const stats = await this.knowledgeManager.getStats(agentId);
        this.panel.webview.postMessage({ type: 'stats_update', agentId, stats });
        break;
      }
      case 'rebuild': {
        const agentId = msg.agentId as string;
        try {
          const agent = this.agentManager.getAgent(agentId);
          if (!agent || !agent.knowledge?.source_folders) {
            throw new Error('Agent configuration or knowledge source folders not found.');
          }
          await this.knowledgeManager.rebuildKnowledgeBase(agentId, agent.knowledge.source_folders, (phase: string, pct?: number) => {
            this.panel.webview.postMessage({ type: 'rebuild_progress', agentId, phase, pct: pct ?? 0 });
          });
          this.panel.webview.postMessage({ type: 'rebuild_complete', agentId });
          const stats = await this.knowledgeManager.getStats(agentId);
          this.panel.webview.postMessage({ type: 'stats_update', agentId, stats });
        } catch (err) {
          this.panel.webview.postMessage({ type: 'rebuild_error', agentId, error: String(err) });
        }
        break;
      }
      case 'test_query': {
        const agentId = msg.agentId as string;
        const query = msg.query as string;
        const topK = Number(msg.topK) || 5;

        try {
          const hasKB = await this.knowledgeManager.hasKnowledgeBase(agentId);
          if (!hasKB) {
            this.panel.webview.postMessage({ type: 'query_error', error: 'Knowledge base not built yet.' });
            return;
          }
          const evidence = await this.knowledgeManager.query(agentId, query, topK);
          this.panel.webview.postMessage({ type: 'query_result', evidence });
        } catch (err) {
          this.panel.webview.postMessage({ type: 'query_error', error: String(err) });
        }
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
  <title>Knowledge Base Manager</title>
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
    label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; opacity: 0.75; }
    select, input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 6px 16px; font-size: 13px; cursor: pointer;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .card {
      padding: 16px;
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      margin-bottom: 20px;
    }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .stat-box { background: rgba(0,0,0,0.1); padding: 10px; border-radius: 4px; }
    .stat-label { font-size: 11px; opacity: 0.7; }
    .stat-value { font-size: 18px; font-weight: 600; margin-top: 4px; }
    #progress-container { margin-top: 16px; display: none; }
    .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-top: 4px; }
    .progress-fill { height: 100%; background: var(--vscode-progressBar-background); width: 0%; transition: width 0.2s; }
    #progress-text { font-size: 11px; opacity: 0.8; }
    
    .query-result { margin-top: 16px; display: none; }
    .chunk {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      padding: 10px;
      margin-bottom: 8px;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-button-background);
    }
    .chunk-meta { font-size: 11px; opacity: 0.7; margin-bottom: 6px; display: flex; justify-content: space-between; }
    .chunk-text { font-size: 12px; white-space: pre-wrap; user-select: text;}
  </style>
</head>
<body>
  <h1>Agent Knowledge Base Management</h1>
  <p style="opacity:0.7; margin-bottom: 20px;">Manage offline, secure RAG vector stores for your local agents.</p>

  <label for="agent-select">Select Agent (Configured with Knowledge Folders)</label>
  <select id="agent-select" onchange="onAgentChanged()">
    <option value="">Loading...</option>
  </select>

  <div class="card" id="stats-card">
    <h2>Knowledge Statistics</h2>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-label">Documents Indexed</div>
        <div class="stat-value" id="stat-docs">-</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Vector Chunks</div>
        <div class="stat-value" id="stat-chunks">-</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Last Built</div>
        <div class="stat-value" id="stat-date" style="font-size: 13px;">-</div>
      </div>
    </div>
    
    <button class="btn" id="btn-rebuild" onclick="rebuild()">Rebuild Knowledge Base</button>
    
    <div id="progress-container">
      <div id="progress-text">Initialising...</div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
    </div>
  </div>

  <div class="card" id="query-card">
    <h2>Test Query (Bypass LLM)</h2>
    <div style="display:flex; gap:8px;">
      <input type="text" id="query-input" placeholder="Enter a search term..." onkeydown="if(event.key==='Enter') testQuery()" style="margin-bottom:0;" />
      <button class="btn" id="btn-query" onclick="testQuery()">Search</button>
    </div>
    
    <div class="query-result" id="query-result">
      <p style="font-size:12px; margin-bottom:12px; opacity:0.8;" id="query-meta"></p>
      <div id="chunk-list"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    function onAgentChanged() {
      const agentId = document.getElementById('agent-select').value;
      if (agentId) {
        vscode.postMessage({ type: 'get_stats', agentId });
        document.getElementById('query-result').style.display = 'none';
        document.getElementById('chunk-list').innerHTML = '';
      }
    }

    function rebuild() {
      const agentId = document.getElementById('agent-select').value;
      if (!agentId) return;
      
      document.getElementById('btn-rebuild').disabled = true;
      document.getElementById('progress-container').style.display = 'block';
      vscode.postMessage({ type: 'rebuild', agentId });
    }

    function testQuery() {
      const agentId = document.getElementById('agent-select').value;
      const query = document.getElementById('query-input').value.trim();
      if (!agentId || !query) return;
      
      document.getElementById('btn-query').disabled = true;
      document.getElementById('query-result').style.display = 'none';
      document.getElementById('chunk-list').innerHTML = '';
      vscode.postMessage({ type: 'test_query', agentId, query, topK: 5 });
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'agent_list') {
        const sel = document.getElementById('agent-select');
        if (msg.agents.length === 0) {
          sel.innerHTML = '<option value="">No agents have knowledge folders configured.</option>';
          document.getElementById('btn-rebuild').disabled = true;
          document.getElementById('btn-query').disabled = true;
        } else {
          sel.innerHTML = msg.agents.map(a => \`<option value="\${a.id}">@\${a.id} (\${a.name})</option>\`).join('');
          onAgentChanged();
        }
      } else if (msg.type === 'stats_update') {
        const currentAgent = document.getElementById('agent-select').value;
        if (msg.agentId === currentAgent && msg.stats) {
          document.getElementById('stat-docs').textContent = msg.stats.documentCount || 0;
          document.getElementById('stat-chunks').textContent = msg.stats.chunkCount || 0;
          document.getElementById('stat-date').textContent = msg.stats.lastUpdated ? new Date(msg.stats.lastUpdated).toLocaleString() : 'Never';
        }
      } else if (msg.type === 'rebuild_progress') {
        document.getElementById('progress-text').textContent = \`\${msg.phase} (\${Math.round(msg.pct)}%)\`;
        document.getElementById('progress-fill').style.width = \`\${msg.pct}%\`;
      } else if (msg.type === 'rebuild_complete') {
        document.getElementById('btn-rebuild').disabled = false;
        document.getElementById('progress-text').textContent = 'Complete!';
        setTimeout(() => { document.getElementById('progress-container').style.display = 'none'; }, 2000);
      } else if (msg.type === 'rebuild_error') {
        document.getElementById('btn-rebuild').disabled = false;
        document.getElementById('progress-text').textContent = 'Error: ' + msg.error;
        document.getElementById('progress-fill').style.backgroundColor = 'var(--vscode-errorForeground)';
      } else if (msg.type === 'query_result') {
        document.getElementById('btn-query').disabled = false;
        document.getElementById('query-result').style.display = 'block';
        
        document.getElementById('query-meta').textContent = \`Found \${msg.evidence.chunks.length} results in \${msg.evidence.trace.latencyMs}ms\`;
        
        const html = msg.evidence.chunks.map(c => \`
          <div class="chunk">
            <div class="chunk-meta">
              <span><strong>\${c.metadata.sourceFile}</strong> (L\${c.metadata.startLine}-\${c.metadata.endLine})</span>
              <span>Score: \${c.score.toFixed(3)}</span>
            </div>
            <div class="chunk-text">\${c.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          </div>
        \`).join('');
        document.getElementById('chunk-list').innerHTML = html;
      } else if (msg.type === 'query_error') {
        document.getElementById('btn-query').disabled = false;
        document.getElementById('query-result').style.display = 'block';
        document.getElementById('query-meta').textContent = 'Error: ' + msg.error;
      }
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    KnowledgePanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
