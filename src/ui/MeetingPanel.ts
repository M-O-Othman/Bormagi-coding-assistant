import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManager } from '../agents/AgentManager';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { MeetingStorage } from '../meeting/MeetingStorage';
import { MeetingOrchestrator } from '../meeting/MeetingOrchestrator';
import { Meeting, AgendaItem, ActionItem, SummaryRound, ActionPolicy } from '../meeting/types';
import type { AgentConfig } from '../types';

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
    this.orchestrator = new MeetingOrchestrator(agentManager, configManager, workspaceRoot, this.storage);

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
    const agents = this.agentManager.listAgents().map((a: AgentConfig) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      description: a.description
    }));
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
            // Auto-create an action item from the human decision text
            if (decision && decision.trim()) {
              const ai: ActionItem = {
                id: `ai-decision-${Date.now()}`,
                text: `[Decision] ${decision.trim()}`,
                assignedTo: 'Human'
              };
              this.activeMeeting.actionItems.push(ai);
              this.post({ type: 'action_item_added', actionItem: ai });
            }
            await this.storage.saveMeeting(this.activeMeeting);
            this.post({ type: 'item_resolved', agendaItemId, decision });
          }
        }
        break;
      }
      case 'set_action_policy': {
        // Human sets the action gating policy for an agenda item
        const { agendaItemId, policy } = msg as { agendaItemId: string; policy: ActionPolicy | null };
        if (this.activeMeeting) {
          const item = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
          if (item) {
            item.actionPolicy = policy ?? undefined;
            await this.storage.saveMeeting(this.activeMeeting);
            this.post({ type: 'action_policy_set', agendaItemId, policy });
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
    // Generate full formatted minutes (overwrites the incremental file)
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

    // First participant is the meeting moderator
    const moderatorId = participants.length > 0 ? participants[0] : undefined;

    const meeting: Meeting = {
      id,
      title,
      status: 'active',
      created_at: new Date().toISOString(),
      participants,
      resourceFiles,
      agenda,
      rounds: [],
      actionItems: preItems,
      moderatorId,
      summaryRounds: [],
      executionMode: 'planning'
    };

    this.activeMeeting = meeting;
    await this.storage.saveMeeting(meeting);

    // Initialise inline minutes file
    const modName = moderatorId ? (this.agentManager.getAgent(moderatorId)?.name ?? moderatorId) : 'N/A';
    const participantNames = participants.map(p => this.agentManager.getAgent(p)?.name ?? p).join(', ');
    await this.storage.appendMinutesLine(id,
      `# Meeting Minutes: ${title}\n` +
      `**Date:** ${new Date().toLocaleString()}\n` +
      `**Moderator:** ${modName}\n` +
      `**Participants:** ${participantNames}\n`
    );

    this.post({ type: 'meeting_started', meeting });

    // Automatically run the first round for the first agenda item
    if (agenda.length > 0) {
      await this.handleRunRound(agenda[0].id, undefined);
    }
  }

  /** Parse @agent-name mentions from a human message; returns matching agent IDs. */
  private parseUserMentions(userMessage: string): string[] | undefined {
    const pattern = /@([\w-]+)/g;
    const matches = [...userMessage.matchAll(pattern)];
    if (!matches.length) { return undefined; }

    const mentioned: string[] = [];
    for (const m of matches) {
      const name = m[1].toLowerCase();
      const agent = this.agentManager.listAgents().find(a =>
        a.id.toLowerCase() === name ||
        a.name.toLowerCase() === name ||
        a.name.toLowerCase().replace(/\s+/g, '-') === name
      );
      if (agent) { mentioned.push(agent.id); }
    }
    return mentioned.length > 0 ? mentioned : undefined;
  }

  private async handleRunRound(agendaItemId: string, userMessage: string | undefined): Promise<void> {
    if (!this.activeMeeting || this.runningRound) { return; }

    const item = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
    if (!item || item.status === 'resolved' || item.status === 'deferred') { return; }

    // Detect "next / defer / proceed" intent — immediately defer this item without running agents
    const deferIntent = /\b(next agenda item|proceed to next|move on|defer(red)?|postpone|skip this item)\b/i.test(userMessage ?? '');
    if (deferIntent) {
      item.status = 'deferred';
      item.decision = userMessage;
      await this.storage.saveMeeting(this.activeMeeting);
      this.post({ type: 'item_deferred', agendaItemId, reason: userMessage });
      return;
    }

    // Parse @mentions to route question to specific agent(s)
    const targetAgentIds = userMessage ? this.parseUserMentions(userMessage) : undefined;

    item.status = 'discussing';
    this.runningRound = true;
    this.post({ type: 'round_started', agendaItemId, userMessage });

    // Append agenda item header to minutes on first discussion
    const isFirstRoundForItem = !this.activeMeeting.rounds.some(r => r.agendaItemId === agendaItemId);
    if (isFirstRoundForItem) {
      await this.storage.appendMinutesLine(this.activeMeeting.id,
        `\n## ${item.text}\n`
      );
    }

    try {
      await this.orchestrator.runRound(
        this.activeMeeting,
        agendaItemId,
        userMessage,
        // onDelta
        (aid, agentId, delta) => {
          this.post({ type: 'agent_delta', agendaItemId: aid, agentId, delta });
        },
        // onDone
        (aid, agentId, fullResponse, tag) => {
          const isSkip = tag === 'SKIP';
          this.post({ type: 'agent_round_done', agendaItemId: aid, agentId, fullResponse, skipped: isSkip, tag });
          this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
          // Append to inline minutes
          if (!isSkip) {
            const agentName = this.agentManager.getAgent(agentId)?.name ?? agentId;
            this.storage.appendMinutesLine(this.activeMeeting!.id,
              `### ${agentName} [${tag}]\n${fullResponse}\n`
            ).catch(() => { /* ignore */ });
          } else {
            const agentName = this.agentManager.getAgent(agentId)?.name ?? agentId;
            const reason = fullResponse.replace(/^\[SKIP\][:\s]*/i, '').trim();
            this.storage.appendMinutesLine(this.activeMeeting!.id,
              `- ${agentName} skipped: ${reason}\n`
            ).catch(() => { /* ignore */ });
          }
        },
        // onSkip
        (aid, agentId, reason) => {
          this.post({ type: 'agent_skipped', agendaItemId: aid, agentId, reason });
        },
        // onInterruptDelta
        (aid, agentId, triggeredBy, delta) => {
          this.post({ type: 'interrupt_delta', agendaItemId: aid, agentId, triggeredBy, delta });
        },
        // onInterruptDone
        (aid, agentId, triggeredBy, fullResponse, tag) => {
          this.post({ type: 'interrupt_done', agendaItemId: aid, agentId, triggeredBy, fullResponse, tag });
          this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
          const agentName = this.agentManager.getAgent(agentId)?.name ?? agentId;
          const callerName = this.agentManager.getAgent(triggeredBy)?.name ?? triggeredBy;
          this.storage.appendMinutesLine(this.activeMeeting!.id,
            `↳ ${agentName} [${tag}] (interrupt responding to @${callerName})\n${fullResponse}\n`
          ).catch(() => { /* ignore */ });
        },
        // onSummary
        (aid, summary: SummaryRound) => {
          this.post({ type: 'round_summary', agendaItemId: aid, summary });

          // Auto-transition item based on machine-readable status from moderator
          if (this.activeMeeting && summary.itemStatus) {
            const summaryItem = this.activeMeeting.agenda.find(a => a.id === aid);
            if (summaryItem) {
              if (summary.itemStatus === 'deferred') {
                summaryItem.status = 'deferred';
                this.post({ type: 'item_deferred', agendaItemId: aid, reason: summary.deferReason });
                this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
              } else if (summary.itemStatus === 'resolved') {
                summaryItem.status = 'resolved';
                summaryItem.decision = summary.recommendation;
                this.post({ type: 'item_resolved', agendaItemId: aid, decision: summary.recommendation });
                this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
              }
            }
          }

          // Auto-add ACTION items from summary into the action items list
          if (summary.actions && summary.actions.length > 0 && this.activeMeeting) {
            for (const actionText of summary.actions) {
              if (!actionText.trim()) { continue; }
              const ai: ActionItem = {
                id: `ai-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                text: actionText,
                assignedTo: 'TBD'
              };
              this.activeMeeting.actionItems.push(ai);
              this.post({ type: 'action_item_added', actionItem: ai });
            }
            this.storage.saveMeeting(this.activeMeeting).catch(() => { /* ignore */ });
          }

          // Append structured summary to inline minutes
          const lines: string[] = ['### Moderator Summary'];
          if (summary.problem) { lines.push(`Problem: ${summary.problem}`); }
          if (summary.options?.length) {
            lines.push('Options:');
            summary.options.forEach(o => lines.push(`- ${o}`));
          }
          if (summary.recommendation) { lines.push(`Recommendation: ${summary.recommendation}`); }
          if (summary.risks?.length) {
            lines.push('Risks:');
            summary.risks.forEach(r => lines.push(`- ${r}`));
          }
          if (summary.actions?.length) {
            lines.push('Actions:');
            summary.actions.forEach(a => lines.push(`- ${a}`));
          }
          if (summary.decisionPrompt) { lines.push(`\n**Decision for Human:** ${summary.decisionPrompt}`); }
          if (summary.itemStatus) { lines.push(`Status: ${summary.itemStatus}`); }
          this.storage.appendMinutesLine(this.activeMeeting!.id, lines.join('\n') + '\n').catch(() => { /* ignore */ });
        },
        // onOpenQuestion
        (aid, oqId, question, askedBy) => {
          const agentName = this.agentManager.getAgent(askedBy)?.name ?? askedBy;
          this.post({ type: 'open_question_created', agendaItemId: aid, oqId, question, askedBy: agentName });
        },
        // targetAgentIds — route to mentioned agents only
        targetAgentIds,
        // onBlockedForHuman — item needs human answer before agents continue
        (aid) => {
          this.post({ type: 'item_blocked_for_human', agendaItemId: aid });
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
