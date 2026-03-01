import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManager } from '../agents/AgentManager';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { MeetingStorage } from '../meeting/MeetingStorage';
import { MeetingOrchestrator } from '../meeting/MeetingOrchestrator';
import { Meeting, AgendaItem, ActionItem } from '../meeting/types';

export class MeetingPanel {
  private static current: MeetingPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeMeeting: Meeting | null = null;
  private storage: MeetingStorage;
  private orchestrator: MeetingOrchestrator;
  private runningRound = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly workspaceRoot: string,
    secretsManager: SecretsManager
  ) {
    this.panel = panel;
    void secretsManager; // available for future use
    const bormagiDir = path.join(workspaceRoot, '.bormagi');
    this.storage = new MeetingStorage(bormagiDir);
    this.orchestrator = new MeetingOrchestrator(agentManager, configManager, workspaceRoot);

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => this.handleMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data after a short delay to allow webview to initialise
    setTimeout(() => this.sendInitialData(), 300);
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    agentManager: AgentManager,
    configManager: ConfigManager,
    workspaceRoot: string,
    secretsManager: SecretsManager
  ): void {
    if (MeetingPanel.current) {
      MeetingPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'bormagi.meetingRoom',
      'Bormagi — Virtual Meeting',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');

    MeetingPanel.current = new MeetingPanel(panel, extensionUri, agentManager, configManager, workspaceRoot, secretsManager);
  }

  private post(msg: Record<string, unknown>): void {
    this.panel.webview.postMessage(msg);
  }

  private async sendInitialData(): Promise<void> {
    const agents = this.agentManager.listAgents().map(a => ({ id: a.id, name: a.name }));
    this.post({ type: 'agents_list', agents });

    const workspaceFiles = this.getWorkspaceFiles();
    this.post({ type: 'workspace_files', files: workspaceFiles });
  }

  private getWorkspaceFiles(): string[] {
    const results: string[] = [];
    const allowedExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.md', '.txt', '.json', '.yaml', '.yml', '.html', '.css', '.sql']);
    const excludeDirs = new Set(['node_modules', '.git', 'dist', 'out', '.bormagi', '__pycache__']);

    function walk(dir: string, rel: string) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) { walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name); }
        } else if (allowedExt.has(path.extname(entry.name).toLowerCase())) {
          results.push(rel ? `${rel}/${entry.name}` : entry.name);
        }
      }
    }
    walk(this.workspaceRoot, '');
    return results.slice(0, 200);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    switch (type) {
      case 'start_meeting': {
        await this.handleStartMeeting(msg);
        break;
      }
      case 'run_round': {
        // User requests another pass on an agenda item (with optional chat message)
        const { agendaItemId, userMessage } = msg as { agendaItemId: string; userMessage?: string };
        await this.handleRunRound(agendaItemId, userMessage);
        break;
      }
      case 'resolve_item': {
        // User marks an agenda item as resolved with their decision text
        const { agendaItemId, decision } = msg as { agendaItemId: string; decision: string };
        if (this.activeMeeting) {
          const item = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
          if (item) {
            item.status = 'resolved';
            item.decision = decision || undefined;
            await this.storage.saveMeeting(this.activeMeeting);
            this.post({ type: 'item_resolved', agendaItemId, decision });
          }
        }
        break;
      }
      case 'add_action_item': {
        const { text, assignedTo } = msg as { text: string; assignedTo: string };
        if (this.activeMeeting) {
          const ai: ActionItem = { id: `ai-${Date.now()}`, text, assignedTo };
          this.activeMeeting.actionItems.push(ai);
          await this.storage.saveMeeting(this.activeMeeting);
          this.post({ type: 'action_item_added', actionItem: ai });
        }
        break;
      }
      case 'stop_meeting': {
        await this.handleStopMeeting();
        break;
      }
      case 'generate_minutes': {
        if (this.activeMeeting) {
          const markdown = await this.orchestrator.generateMinutes(this.activeMeeting);
          await this.storage.saveMinutes(this.activeMeeting.id, markdown);
          this.post({ type: 'minutes_ready', markdown });
        }
        break;
      }
      case 'save_minutes': {
        const { markdown } = msg as { markdown: string };
        if (this.activeMeeting) {
          await this.storage.saveMinutes(this.activeMeeting.id, markdown);
          vscode.window.showInformationMessage('Minutes saved.');
        }
        break;
      }
    }
  }

  private async handleStopMeeting(): Promise<void> {
    if (!this.activeMeeting) { return; }
    this.orchestrator.abort();
    // Give the current stream a moment to receive the abort signal
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    this.activeMeeting.status = 'completed';
    await this.storage.saveMeeting(this.activeMeeting);
    const minutes = await this.orchestrator.generateMinutes(this.activeMeeting);
    await this.storage.saveMinutes(this.activeMeeting.id, minutes);
    this.post({ type: 'meeting_stopped', minutes });
  }

  private async handleStartMeeting(msg: Record<string, unknown>): Promise<void> {
    const { title, agendaLines, participants, resourceFiles, initialActionItems } = msg as {
      title: string;
      agendaLines: string[];
      participants: string[];
      resourceFiles: string[];
      initialActionItems?: Array<{ text: string; assignedTo: string }>;
    };

    const id = this.storage.generateId();
    const agenda: AgendaItem[] = agendaLines
      .map((text) => text.trim())
      .filter(t => t.length > 0)
      .map((text, i) => ({ id: `item-${i}`, text, status: 'pending' as const }));

    const preItems: ActionItem[] = (initialActionItems ?? []).map((ai, i) => ({
      id: `ai-pre-${i}`,
      text: ai.text,
      assignedTo: ai.assignedTo
    }));

    const meeting: Meeting = {
      id,
      title,
      status: 'active',
      created_at: new Date().toISOString(),
      participants,
      resourceFiles,
      agenda,
      rounds: [],
      actionItems: preItems
    };

    this.activeMeeting = meeting;
    await this.storage.saveMeeting(meeting);
    this.post({ type: 'meeting_started', meeting });

    // Automatically run the first round for the first agenda item
    if (agenda.length > 0) {
      await this.handleRunRound(agenda[0].id, undefined);
    }
  }

  private async handleRunRound(agendaItemId: string, userMessage: string | undefined): Promise<void> {
    if (!this.activeMeeting || this.runningRound) { return; }

    const item = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
    if (!item || item.status === 'resolved') { return; }

    item.status = 'discussing';
    this.runningRound = true;
    this.post({ type: 'round_started', agendaItemId, userMessage });

    try {
      await this.orchestrator.runRound(
        this.activeMeeting,
        agendaItemId,
        userMessage,
        (aid, agentId, delta) => {
          this.post({ type: 'agent_delta', agendaItemId: aid, agentId, delta });
        },
        (aid, agentId, fullResponse) => {
          this.post({ type: 'agent_round_done', agendaItemId: aid, agentId, fullResponse });
          this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
        }
      );

      this.post({ type: 'round_complete', agendaItemId });
      await this.storage.saveMeeting(this.activeMeeting);
    } catch (err) {
      this.post({ type: 'round_error', agendaItemId, error: (err as Error).message });
    } finally {
      this.runningRound = false;
    }
  }

  private getHtml(): string {
    const mediaPath = path.join(this.extensionUri.fsPath, 'media', 'meeting-room.html');
    if (fs.existsSync(mediaPath)) {
      return fs.readFileSync(mediaPath, 'utf8');
    }
    return '<html><body><p>Meeting room HTML not found.</p></body></html>';
  }

  private dispose(): void {
    MeetingPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
