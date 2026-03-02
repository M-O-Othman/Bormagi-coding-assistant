import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManager } from '../agents/AgentManager';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { MeetingStorage } from '../meeting/MeetingStorage';
import { MeetingOrchestrator } from '../meeting/MeetingOrchestrator';
import { Meeting, AgendaItem, ActionItem, SummaryRound, ActionPolicy, HumanTurn } from '../meeting/types';
import { loadMeetingGuardrails, MeetingGuardrailsConfig } from '../meeting/MeetingGuardrails';
import type { AgentConfig } from '../types';

/** Stored while waiting for the user's offline-agent decision before creating the meeting. */
interface PendingMeetingSetup {
  title: string;
  agendaLines: string[];
  participants: string[];
  resourceFiles: string[];
  initialActionItems?: Array<{ text: string; assignedTo: string }>;
  offlineAgentIds: string[];
}

export class MeetingPanel {
  private static current: MeetingPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeMeeting: Meeting | null = null;
  private storage: MeetingStorage;
  private orchestrator: MeetingOrchestrator;
  private guardrails: MeetingGuardrailsConfig;
  private runningRound = false;
  /** Non-null while waiting for user to decide what to do with offline agents. */
  private pendingMeetingSetup: PendingMeetingSetup | null = null;
  private marked: any;

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
    this.guardrails = loadMeetingGuardrails(workspaceRoot);

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

  static async createOrShow(
    extensionUri: vscode.Uri,
    agentManager: AgentManager,
    configManager: ConfigManager,
    workspaceRoot: string,
    secretsManager: SecretsManager
  ): Promise<void> {
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

    const meetingPanel = new MeetingPanel(panel, extensionUri, agentManager, configManager, workspaceRoot, secretsManager);
    await meetingPanel.initialize();
    MeetingPanel.current = meetingPanel;
  }

  private async initialize() {
    const { marked } = await import('marked');
    this.marked = marked;
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
            const trimmedDecision = (decision ?? '').trim();
            item.status = 'resolved';
            item.decision = trimmedDecision || undefined;
            item.blockedByHuman = false;
            if (trimmedDecision) {
              this.recordFinalDecision(agendaItemId, trimmedDecision);
            }
            // Auto-create an action item from the human decision text
            if (trimmedDecision) {
              const ai: ActionItem = {
                id: `ai-decision-${Date.now()}`,
                text: `[Decision] ${trimmedDecision}`,
                assignedTo: 'Human'
              };
              this.activeMeeting.actionItems.push(ai);
              this.post({ type: 'action_item_added', actionItem: ai });
            }
            await this.storage.saveMeeting(this.activeMeeting);
            this.post({ type: 'item_resolved', agendaItemId, decision: trimmedDecision });
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
      case 'offline_agent_decision': {
        // User chose how to handle offline agents: 'proceed' removes them, 'reconfigure' cancels setup
        const { action } = msg as { action: 'proceed' | 'reconfigure' };
        await this.handleOfflineAgentDecision(action);
        break;
      }
      case 'retry_availability_check': {
        // User fixed an agent and wants to recheck before starting
        if (this.pendingMeetingSetup) {
          const setup = this.pendingMeetingSetup;
          this.pendingMeetingSetup = null;
          await this.handleStartMeetingWithParams(setup);
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
    const params = msg as {
      title: string;
      agendaLines: string[];
      participants: string[];
      resourceFiles: string[];
      initialActionItems?: Array<{ text: string; assignedTo: string }>;
    };
    await this.handleStartMeetingWithParams(params);
  }

  private async handleStartMeetingWithParams(params: {
    title: string;
    agendaLines: string[];
    participants: string[];
    resourceFiles: string[];
    initialActionItems?: Array<{ text: string; assignedTo: string }>;
  }): Promise<void> {
    const { title, agendaLines, participants, resourceFiles, initialActionItems } = params;

    // ── 1. Availability check ──────────────────────────────────────────────
    this.post({ type: 'availability_checking' });
    const { online, offline } = await this.orchestrator.checkAgentsAvailability(participants);

    if (offline.length > 0) {
      const offlineNames = offline.map(id => this.agentManager.getAgent(id)?.name ?? id);
      this.pendingMeetingSetup = { title, agendaLines, participants, resourceFiles, initialActionItems, offlineAgentIds: offline };
      this.post({ type: 'agents_availability_check', offlineAgentIds: offline, offlineAgentNames: offlineNames });
      return; // wait for offline_agent_decision message
    }

    if (online.length === 0) {
      this.post({ type: 'meeting_ended_no_agents' });
      return;
    }

    await this.launchMeeting({ title, agendaLines, participants: online, resourceFiles, initialActionItems });
  }

  private async handleOfflineAgentDecision(action: 'proceed' | 'reconfigure'): Promise<void> {
    if (!this.pendingMeetingSetup) { return; }

    if (action === 'reconfigure') {
      // Return to setup screen without clearing the form — user will fix and resubmit
      this.pendingMeetingSetup = null;
      this.post({ type: 'meeting_setup_cancelled' });
      return;
    }

    // proceed — remove offline agents and start with whoever is left
    const setup = this.pendingMeetingSetup;
    this.pendingMeetingSetup = null;
    const validParticipants = setup.participants.filter(id => !setup.offlineAgentIds.includes(id));

    if (validParticipants.length === 0) {
      this.post({ type: 'meeting_ended_no_agents' });
      return;
    }

    await this.launchMeeting({
      title: setup.title,
      agendaLines: setup.agendaLines,
      participants: validParticipants,
      resourceFiles: setup.resourceFiles,
      initialActionItems: setup.initialActionItems
    });
  }

  private async launchMeeting(params: {
    title: string;
    agendaLines: string[];
    participants: string[];
    resourceFiles: string[];
    initialActionItems?: Array<{ text: string; assignedTo: string }>;
  }): Promise<void> {
    const { title, agendaLines, participants, resourceFiles, initialActionItems } = params;

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

    // First online participant is the moderator
    const moderatorId = participants[0];

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
    const modName = this.agentManager.getAgent(moderatorId)?.name ?? moderatorId;
    const participantNames = participants.map(p => this.agentManager.getAgent(p)?.name ?? p).join(', ');
    await this.storage.appendMinutesLine(id,
      `# Meeting Minutes: ${title}\n` +
      `**Date:** ${new Date().toLocaleString()}\n` +
      `**Moderator:** ${modName}\n` +
      `**Participants:** ${participantNames}\n`
    );

    this.post({ type: 'meeting_started', meeting });

    // ── 2. Introduction round (silent — not streamed to the UI feed) ────────
    this.post({ type: 'introduction_started', count: participants.length });
    await this.orchestrator.runIntroductionRound(meeting, (agentId, agentName) => {
      this.post({ type: 'agent_introduced', agentId, agentName });
    });
    await this.storage.saveMeeting(meeting);
    this.post({ type: 'introductions_complete' });

    // ── 3. First agenda round ───────────────────────────────────────────────
    if (agenda.length > 0) {
      await this.handleRunRound(agenda[0].id, undefined);
    }
  }

  /** Record a human message in meeting.humanTurns and write it to the inline minutes. */
  private async recordHumanTurn(agendaItemId: string, message: string): Promise<void> {
    if (!this.activeMeeting) { return; }
    const turn: HumanTurn = { agendaItemId, message, timestamp: new Date().toISOString() };
    if (!this.activeMeeting.humanTurns) { this.activeMeeting.humanTurns = []; }
    this.activeMeeting.humanTurns.push(turn);
    await this.storage.appendMinutesLine(this.activeMeeting.id, `**[Human]:** ${message}\n`);
  }

  /** Parse @mentions from a human message; supports IDs and display names (including spaces). */
  private parseUserMentions(userMessage: string): string[] | undefined {
    if (!this.activeMeeting) { return undefined; }
    const text = userMessage.toLowerCase();
    const participants = new Set(this.activeMeeting.participants);
    const mentioned = new Set<string>();

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const agent of this.agentManager.listAgents()) {
      if (!participants.has(agent.id)) { continue; }
      const aliases = [
        agent.id.toLowerCase(),
        agent.name.toLowerCase(),
        agent.name.toLowerCase().replace(/\s+/g, '-')
      ];
      for (const alias of aliases) {
        const re = new RegExp(`(^|\\s)@${escapeRegex(alias)}(?=\\s|$|[.,!?;:])`, 'i');
        if (re.test(text)) {
          mentioned.add(agent.id);
          break;
        }
      }
    }

    return mentioned.size > 0 ? Array.from(mentioned) : undefined;
  }

  private matchesAnyPattern(text: string, patterns: string[]): boolean {
    const lower = text.toLowerCase();
    for (const p of patterns) {
      try {
        if (new RegExp(p, 'i').test(lower)) { return true; }
      } catch {
        // Ignore malformed user-configured patterns
      }
    }
    return false;
  }

  private extractDecisionOption(text: string): string | undefined {
    const lower = text.toLowerCase();
    for (const p of this.guardrails.humanIntent.optionExtractPatterns) {
      try {
        const m = lower.match(new RegExp(p, 'i'));
        if (m?.[1]) { return m[1].toUpperCase(); }
      } catch {
        // Ignore malformed user-configured patterns
      }
    }
    return undefined;
  }

  private isHumanFinalDecision(text: string): boolean {
    return this.matchesAnyPattern(text, this.guardrails.humanIntent.finalDecisionPatterns);
  }

  private isHumanDeferIntent(text: string): boolean {
    return this.matchesAnyPattern(text, this.guardrails.humanIntent.deferPatterns);
  }

  private recordFinalDecision(agendaItemId: string, decisionText: string): void {
    if (!this.activeMeeting) { return; }
    if (!this.activeMeeting.decisions) { this.activeMeeting.decisions = {}; }
    this.activeMeeting.decisions[agendaItemId] = {
      option: this.extractDecisionOption(decisionText) ?? decisionText.trim(),
      chosenOption: this.extractDecisionOption(decisionText),
      decidedByHumanAt: new Date().toISOString(),
      isFinal: true,
      notes: decisionText.trim()
    };
  }

  /** Shared summary handler — called from both the normal onSummary callback and the defer closeout path. */
  private handleSummaryRound(aid: string, summary: SummaryRound): void {
    if (!this.activeMeeting) { return; }

    // Auto-transition item based on machine-readable status from moderator
    const summaryItem = this.activeMeeting.agenda.find(a => a.id === aid);
    const finalDecision = this.activeMeeting.decisions?.[aid];
    const hasFinalDecision = Boolean(finalDecision?.isFinal);
    if (summaryItem && summary.itemStatus) {
      if (summary.itemStatus === 'deferred') {
        summaryItem.status = 'deferred';
        if (summary.deferReason) { summaryItem.deferReason = summary.deferReason; }
        this.post({ type: 'item_deferred', agendaItemId: aid, reason: summary.deferReason });
        this.storage.saveMeeting(this.activeMeeting).catch(() => { /* ignore */ });
      } else if (summary.itemStatus === 'resolved') {
        if (hasFinalDecision) {
          const wasResolved = summaryItem.status === 'resolved';
          summaryItem.status = 'resolved';
          summaryItem.decision = summaryItem.decision ?? finalDecision?.notes ?? finalDecision?.option;
          if (!wasResolved) {
            this.post({ type: 'item_resolved', agendaItemId: aid, decision: summaryItem.decision });
          }
          this.storage.saveMeeting(this.activeMeeting).catch(() => { /* ignore */ });
        } else {
          // Guardrail: moderators cannot finalize unresolved items without explicit human decision.
          summary.itemStatus = 'ready_for_human_decision';
          summaryItem.status = 'discussing';
        }
      }
    }

    this.post({ type: 'round_summary', agendaItemId: aid, summary });

    // Auto-add ACTION items from summary — gated behind actionPolicy
    const actionsBlocked = summaryItem?.actionPolicy &&
      summaryItem.actionPolicy.mode !== 'NORMAL' &&
      summaryItem.actionPolicy.mode !== 'ALLOW_ONLY_ACTIONS'; // ALLOW_ONLY_ACTIONS still allows them in summary
    if (!actionsBlocked && summary.actions && summary.actions.length > 0) {
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
    if (summary.deferReason) { lines.push(`DeferReason: ${summary.deferReason}`); }
    this.storage.appendMinutesLine(this.activeMeeting.id, lines.join('\n') + '\n').catch(() => { /* ignore */ });
  }

  private async handleRunRound(agendaItemId: string, userMessage: string | undefined): Promise<void> {
    if (!this.activeMeeting || this.runningRound) { return; }

    const item = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
    if (!item || item.status === 'resolved' || item.status === 'deferred') { return; }

    const cleanedUserMessage = userMessage?.trim();
    if (cleanedUserMessage) {
      await this.recordHumanTurn(agendaItemId, cleanedUserMessage);
    }

    // Detect explicit human decision and lock the item immediately.
    const finalDecisionIntent = Boolean(cleanedUserMessage && this.isHumanFinalDecision(cleanedUserMessage));
    if (finalDecisionIntent && cleanedUserMessage) {
      this.recordFinalDecision(agendaItemId, cleanedUserMessage);
      item.status = 'resolved';
      item.decision = cleanedUserMessage;
      item.blockedByHuman = false;

      const ai: ActionItem = {
        id: `ai-decision-${Date.now()}`,
        text: `[Decision] ${cleanedUserMessage}`,
        assignedTo: 'Human'
      };
      this.activeMeeting.actionItems.push(ai);
      this.post({ type: 'action_item_added', actionItem: ai });
      this.post({ type: 'item_resolved', agendaItemId, decision: cleanedUserMessage });

      this.runningRound = true;
      this.post({ type: 'round_started', agendaItemId, userMessage: cleanedUserMessage });
      try {
        const summary = await this.orchestrator.generateStructuredSummary(
          this.activeMeeting,
          agendaItemId,
          { status: 'resolved', reason: cleanedUserMessage }
        );
        if (summary) { this.handleSummaryRound(agendaItemId, summary); }
        this.post({ type: 'round_complete', agendaItemId });
        await this.storage.saveMeeting(this.activeMeeting);
      } catch (err) {
        this.post({ type: 'round_error', agendaItemId, error: (err as Error).message });
      } finally {
        this.runningRound = false;
      }
      return;
    }

    // Detect "next / defer / proceed" intent — run a moderator closeout summary instead of a full agent round
    const deferIntent = Boolean(cleanedUserMessage && this.isHumanDeferIntent(cleanedUserMessage));
    if (deferIntent) {
      item.blockedByHuman = false;
      item.deferReason = cleanedUserMessage;
      // Don't skip the orchestrator — run a moderator-only closeout to get a proper summary entry
      this.runningRound = true;
      this.post({ type: 'round_started', agendaItemId, userMessage: cleanedUserMessage });
      try {
        const summary = await this.orchestrator.generateStructuredSummary(
          this.activeMeeting, agendaItemId,
          { status: 'deferred', reason: cleanedUserMessage ?? 'Human deferred this item.' }
        );
        if (summary) { this.handleSummaryRound(agendaItemId, summary); }
        // If summary didn't auto-fire item_deferred (e.g. status parse failed), fire it manually
        // Re-look up item to get the post-handleSummaryRound status (avoids TS narrowing issue)
        const itemAfter = this.activeMeeting.agenda.find(a => a.id === agendaItemId);
        if (itemAfter && itemAfter.status !== 'deferred') {
          itemAfter.status = 'deferred';
          this.post({ type: 'item_deferred', agendaItemId, reason: cleanedUserMessage });
        }
        this.post({ type: 'round_complete', agendaItemId });
        await this.storage.saveMeeting(this.activeMeeting);
      } catch (err) {
        // If closeout summary fails, fall back to direct deferral
        item.status = 'deferred';
        this.post({ type: 'item_deferred', agendaItemId, reason: cleanedUserMessage });
        this.post({ type: 'round_error', agendaItemId, error: (err as Error).message });
        await this.storage.saveMeeting(this.activeMeeting);
      } finally {
        this.runningRound = false;
      }
      return;
    }

    // Parse @mentions to route question to specific agent(s)
    const targetAgentIds = cleanedUserMessage ? this.parseUserMentions(cleanedUserMessage) : undefined;

    item.status = 'discussing';
    this.runningRound = true;
    this.post({ type: 'round_started', agendaItemId, userMessage: cleanedUserMessage });

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
        cleanedUserMessage,
        // onDelta
        (aid, agentId, delta) => {
          this.post({ type: 'agent_delta', agendaItemId: aid, agentId, delta });
        },
        // onDone
        (aid, agentId, fullResponse, tag) => {
          const isSkip = tag === 'SKIP';
          const rendered = this.marked.parse(fullResponse, { breaks: true }) as string;
          this.post({ type: 'agent_round_done', agendaItemId: aid, agentId, fullResponse: rendered, skipped: isSkip, tag });
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
          const rendered = this.marked.parse(fullResponse, { breaks: true }) as string;
          this.post({ type: 'interrupt_done', agendaItemId: aid, agentId, triggeredBy, fullResponse: rendered, tag });
          this.storage.saveMeeting(this.activeMeeting!).catch(() => { /* ignore */ });
          const agentName = this.agentManager.getAgent(agentId)?.name ?? agentId;
          const callerName = this.agentManager.getAgent(triggeredBy)?.name ?? triggeredBy;
          this.storage.appendMinutesLine(this.activeMeeting!.id,
            `↳ ${agentName} [${tag}] (interrupt responding to @${callerName})\n${fullResponse}\n`
          ).catch(() => { /* ignore */ });
        },
        // onSummary — delegate to shared handler
        (aid, summary: SummaryRound) => { this.handleSummaryRound(aid, summary); },
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
