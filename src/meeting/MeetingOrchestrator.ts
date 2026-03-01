import * as fs from 'fs';
import * as path from 'path';
import { Meeting, AgendaItem, MeetingRound } from './types';
import { AgentManager } from '../agents/AgentManager';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderFactory } from '../providers/ProviderFactory';
import { ChatMessage } from '../types';

export type RoundDeltaCallback = (agendaItemId: string, agentId: string, delta: string) => void;
export type RoundDoneCallback = (agendaItemId: string, agentId: string, fullResponse: string) => void;

export class MeetingOrchestrator {
  private aborted = false;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly workspaceRoot: string
  ) {}

  /** Signal the orchestrator to stop after the current agent finishes. */
  abort(): void { this.aborted = true; }

  private resetAbort(): void { this.aborted = false; }

  /**
   * Run one round of responses for a single agenda item.
   * Each participant agent responds once, seeing all prior rounds for this item
   * (including from previous passes and the optional user message).
   *
   * Round-robin: the caller (MeetingPanel) decides how many passes to run.
   */
  async runRound(
    meeting: Meeting,
    agendaItemId: string,
    userMessage: string | undefined,
    onDelta: RoundDeltaCallback,
    onDone: RoundDoneCallback
  ): Promise<void> {
    this.resetAbort();
    const item = meeting.agenda.find(a => a.id === agendaItemId);
    if (!item) { return; }

    const resourceContext = this.loadResourceFiles(meeting.resourceFiles);

    for (const agentId of meeting.participants) {
      if (this.aborted) { break; }
      const agentConfig = this.agentManager.getAgent(agentId);
      if (!agentConfig) { continue; }

      // Resolve provider + API key (mirrors AgentRunner fallback logic)
      let effectiveProvider = agentConfig.provider;
      let apiKeyId = agentId;

      const explicitDefault = agentConfig.useDefaultProvider || !agentConfig.provider?.type;
      if (explicitDefault) {
        const def = await this.configManager.readDefaultProvider();
        if (!def?.type) { continue; }
        effectiveProvider = def;
        apiKeyId = '__default__';
      } else {
        const needsOwnKey = (agentConfig.provider?.auth_method ?? 'api_key') === 'api_key';
        if (needsOwnKey) {
          const ownKey = await this.agentManager.getApiKey(agentId);
          if (!ownKey) {
            const def = await this.configManager.readDefaultProvider();
            if (def?.type) {
              const defNeedsKey = (def.auth_method ?? 'api_key') === 'api_key';
              const defKey = defNeedsKey ? await this.agentManager.getApiKey('__default__') : 'ok';
              if (defKey) { effectiveProvider = def; apiKeyId = '__default__'; }
            }
          }
        }
      }

      const apiKey = await this.agentManager.getApiKey(apiKeyId);
      if (!apiKey && (effectiveProvider?.auth_method ?? 'api_key') === 'api_key') { continue; }

      const providerConfig = { ...agentConfig, provider: effectiveProvider };
      const provider = ProviderFactory.create(providerConfig, apiKey ?? '');

      // Build system prompt from agent config
      const systemPromptFiles = agentConfig.system_prompt_files ?? [];
      let systemPrompt = `You are ${agentConfig.name}. You are participating in a virtual meeting titled: "${meeting.title}".\n`;
      for (const spFile of systemPromptFiles) {
        const spPath = path.join(this.workspaceRoot, '.bormagi', 'agents-definition', agentId, spFile);
        if (fs.existsSync(spPath)) {
          systemPrompt += '\n' + fs.readFileSync(spPath, 'utf8');
        }
      }
      // Meeting behaviour constraints — always appended last so they take priority
      systemPrompt +=
        '\n\nMEETING BEHAVIOUR RULES (mandatory):\n' +
        '- Communicate exclusively in plain, conversational English prose.\n' +
        '- Do NOT write code blocks, shell commands, scripts, or terminal output.\n' +
        '- Describe technical ideas by explaining intent, approach, and trade-offs in words.\n' +
        '- Keep your contribution concise — one to three paragraphs maximum.\n' +
        '- Only produce actual code if the meeting chair explicitly asks for it (e.g. "show the code" or "write the implementation").';


      // Build conversation messages — system prompt first
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt }
      ];

      // Resource files context
      if (resourceContext) {
        messages.push({ role: 'user', content: `[Meeting Resources]\n${resourceContext}` });
        messages.push({ role: 'assistant', content: 'Understood. I have reviewed the provided resources.' });
      }

      // All prior rounds for this agenda item (from ALL previous passes)
      const priorRounds: MeetingRound[] = meeting.rounds.filter(r => r.agendaItemId === agendaItemId);
      if (priorRounds.length > 0) {
        const priorText = priorRounds.map(r =>
          `**${r.agentId}**: ${r.response}`
        ).join('\n\n');
        messages.push({ role: 'user', content: `[Discussion so far on this agenda item]\n${priorText}` });
        messages.push({ role: 'assistant', content: 'I have reviewed the discussion so far.' });
      }

      // The agenda item + optional user message this round
      let prompt = `Agenda item: "${item.text}"\n\n`;
      if (userMessage) {
        prompt += `The meeting chair has added: "${userMessage}"\n\n`;
      }
      prompt += `Please share your perspective, analysis, and any recommendations from your area of expertise.`;
      messages.push({ role: 'user', content: prompt });

      // Stream the response
      let fullResponse = '';
      for await (const event of provider.stream(messages, [])) {
        if (this.aborted) { break; }
        if (event.type === 'text') {
          fullResponse += event.delta;
          onDelta(agendaItemId, agentId, event.delta);
        }
      }

      const round: MeetingRound = {
        agendaItemId,
        agentId,
        response: fullResponse,
        timestamp: new Date().toISOString()
      };
      meeting.rounds.push(round);
      onDone(agendaItemId, agentId, fullResponse);
    }
  }

  /**
   * Generate meeting minutes as Markdown from the completed meeting.
   */
  async generateMinutes(meeting: Meeting): Promise<string> {
    const lines: string[] = [
      `# Meeting Minutes: ${meeting.title}`,
      `**Date:** ${new Date(meeting.created_at).toLocaleString()}`,
      `**Participants:** ${meeting.participants.join(', ')}`,
      ''
    ];

    for (const item of meeting.agenda) {
      lines.push(`## ${item.text}`);
      lines.push(`**Status:** ${item.status}`);
      if (item.decision) {
        lines.push(`**Decision:** ${item.decision}`);
      }
      lines.push('');

      const rounds = meeting.rounds.filter(r => r.agendaItemId === item.id);
      for (const round of rounds) {
        lines.push(`### ${round.agentId}`);
        lines.push(round.response);
        lines.push('');
      }
    }

    if (meeting.actionItems.length > 0) {
      lines.push('## Action Items');
      for (const ai of meeting.actionItems) {
        lines.push(`- **${ai.assignedTo}:** ${ai.text}`);
      }
    }

    return lines.join('\n');
  }

  private loadResourceFiles(relativePaths: string[]): string {
    const parts: string[] = [];
    for (const rel of relativePaths) {
      const abs = path.join(this.workspaceRoot, rel);
      if (fs.existsSync(abs)) {
        try {
          const content = fs.readFileSync(abs, 'utf8');
          parts.push(`### ${rel}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
        } catch {
          // skip unreadable files
        }
      }
    }
    return parts.join('\n\n');
  }
}
