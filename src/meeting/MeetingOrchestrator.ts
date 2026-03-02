import * as fs from 'fs';
import * as path from 'path';
import { Meeting, MeetingRound, SummaryRound, OutputTag, InterruptRequest } from './types';
import { MeetingStorage } from './MeetingStorage';
import { AgentManager } from '../agents/AgentManager';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderFactory } from '../providers/ProviderFactory';
import { ChatMessage, AgentConfig } from '../types';

// ── Callback types ────────────────────────────────────────────────────────────

export type RoundDeltaCallback = (agendaItemId: string, agentId: string, delta: string) => void;
export type RoundDoneCallback = (agendaItemId: string, agentId: string, fullResponse: string, tag: OutputTag) => void;
export type RoundSkipCallback = (agendaItemId: string, agentId: string, reason: string) => void;
export type InterruptDeltaCallback = (agendaItemId: string, agentId: string, triggeredBy: string, delta: string) => void;
export type InterruptDoneCallback = (agendaItemId: string, agentId: string, triggeredBy: string, fullResponse: string, tag: OutputTag) => void;
export type SummaryCallback = (agendaItemId: string, summary: SummaryRound) => void;
export type OpenQuestionCallback = (agendaItemId: string, oqId: string, question: string, askedBy: string) => void;
export type BlockedForHumanCallback = (agendaItemId: string) => void;

// Default allowed output tags (used if file is missing)
const DEFAULT_ALLOWED_TAGS: OutputTag[] = [
  'RECOMMENDATION', 'RISK', 'OPEN_QUESTION', 'ACTION',
  'VALIDATION', 'CLARIFICATION_FOR_HUMAN', 'SKIP'
];

// Default banned phrases (used if file is missing)
const DEFAULT_BANNED_PHRASES = [
  'thank you', 'thanks for', 'great point', 'building on',
  'i agree with', 'excellent suggestion', 'well said',
  'good point', 'absolutely', 'as mentioned earlier',
  'i would like to add', 'to summarize what'
];

/**
 * Past-tense code/work completion claims that are banned in planning meetings.
 * These patterns indicate an agent is claiming actual implementation work was done,
 * which is forbidden — meetings produce plans, not code changes.
 */
const CODE_CHANGE_CLAIM_PATTERNS: RegExp[] = [
  // Direct first-person completion claims
  /\bi(?:'ve| have) created (?:the |a )?(?:file|class|function|method|module|component|service|test|migration|schema|config|script)/i,
  /\bi(?:'ve| have) (?:updated|modified|changed|edited) (?:the |a )?(?:file|class|function|requirement|adr|doc|readme|config|schema|code|implementation)/i,
  /\bi(?:'ve| have) implemented/i,
  /\bi(?:'ve| have) written (?:the |a )?(?:code|function|class|test|script|file)/i,
  /\bi(?:'ve| have) committed/i,
  /\bi(?:'ve| have) (?:pushed|deployed|merged|released)/i,
  /\bi(?:'ve| have) (?:refactored|renamed|deleted|removed the code)/i,
  // Passive completion claims
  /\bfile(?:s)? (?:is|are|has been|have been) created\b/i,
  /\b(?:has|have) been (?:updated|modified|implemented|committed|deployed|written|created|refactored) (?:to reflect|in|with)\b/i,
  /\bcode (?:is|has been) (?:now )?(?:updated|modified|written|committed|implemented)\b/i,
  /\bchanges (?:are|have been) (?:made|committed|applied|pushed|implemented)\b/i,
  // Decision/status drift (claiming a decision was made without human input)
  /\badr status changed to (?:accepted|approved|rejected)/i,
  /\bstatus (?:is now|changed to|has been set to) (?:accepted|approved|done|complete|resolved)\b/i,
  // Requirements drift
  /\brequirements? (?:now|already) reflects?\b/i,
  /\brequirements? (?:have been|has been|were) updated to reflect\b/i,
  /\bupdated (?:the )?requirements? to reflect (?:the )?(?:approved|accepted|decided)\b/i,
];

// ── Main class ────────────────────────────────────────────────────────────────

export class MeetingOrchestrator {
  private aborted = false;
  private readonly configDir: string;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly workspaceRoot: string,
    private readonly storage: MeetingStorage
  ) {
    this.configDir = path.join(this.workspaceRoot, '.bormagi', 'meeting-config');
  }

  abort(): void { this.aborted = true; }
  private resetAbort(): void { this.aborted = false; }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONFIG LOADING
  // ══════════════════════════════════════════════════════════════════════════

  private loadConfig(filename: string, defaultContent: string): string {
    const filePath = path.join(this.configDir, filename);
    if (fs.existsSync(filePath)) {
      try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { /* fallback */ }
    }
    return defaultContent.trim();
  }

  private loadConfigList(filename: string, defaultList: string[]): string[] {
    const content = this.loadConfig(filename, defaultList.join('\n'));
    return content.split('\n').map(l => l.trim()).filter(Boolean);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PARSING UTILITIES
  // ══════════════════════════════════════════════════════════════════════════

  /** Parse the output tag from the first line of a response. */
  private parseTag(response: string): OutputTag | null {
    const allowedTags = this.loadConfigList('output-tags.txt', DEFAULT_ALLOWED_TAGS).map(t => t.toUpperCase());
    const trimmed = response.trimStart();
    // [SKIP] or [SKIP]: reason
    if (/^\[SKIP\]/i.test(trimmed)) { return 'SKIP'; }
    // TAG: content
    const tagMatch = trimmed.match(/^([A-Za-z0-9_-]+):/);
    if (tagMatch) {
      const candidate = tagMatch[1].toUpperCase();
      if (allowedTags.includes(candidate)) { return candidate; }
    }
    return null;
  }

  /** Check if a response contains banned talkshop language. */
  private containsBannedLanguage(response: string): boolean {
    const banned = this.loadConfigList('banned-phrases.txt', DEFAULT_BANNED_PHRASES);
    const lower = response.toLowerCase();
    return banned.some(phrase => lower.includes(phrase.toLowerCase()));
  }

  /**
   * Check if a response contains past-tense code/work completion claims.
   * Such claims are forbidden in planning meetings — agents must plan, not claim to implement.
   */
  private containsCodeChangeClaim(response: string): string | null {
    for (const pattern of CODE_CHANGE_CLAIM_PATTERNS) {
      const match = response.match(pattern);
      if (match) { return match[0]; }
    }
    return null;
  }

  /**
   * Parse INTERRUPT_REQUEST lines from a response.
   * Format: INTERRUPT_REQUEST: @AgentName — <question> — Context: <text>
   * Returns max 2 requests.
   */
  extractInterruptRequests(
    response: string,
    participants: string[],
    currentAgentId: string
  ): InterruptRequest[] {
    const results: InterruptRequest[] = [];
    const nameToId = this.buildAgentNameMap(participants, currentAgentId);

    const lines = response.split('\n');
    for (const line of lines) {
      if (results.length >= 2) { break; }
      const match = line.match(/INTERRUPT_REQUEST:\s*@([\w-]+)\s*[—–-]\s*(.+?)(?:\s*[—–-]\s*Context:\s*(.+))?$/i);
      if (!match) { continue; }

      const mentioned = match[1].toLowerCase();
      const agentId = nameToId.get(mentioned);
      if (!agentId) { continue; }

      results.push({
        mentionedAgentId: agentId,
        question: match[2].trim(),
        context: match[3]?.trim()
      });
    }
    return results;
  }

  /** Parse OPEN_QUESTION structured fields from a response. */
  static parseOpenQuestion(response: string): { question: string; whyItMatters: string; exampleAnswer: string } | null {
    // Look for bullet fields
    const qMatch = response.match(/\*\*Question\*\*[:\s]*(.+)/i) ?? response.match(/Question[:\s]*(.+)/i);
    const whyMatch = response.match(/\*\*Why it matters\*\*[:\s]*(.+)/i) ?? response.match(/Why it matters[:\s]*(.+)/i) ?? response.match(/\*\*What it blocks\*\*[:\s]*(.+)/i);
    const exMatch = response.match(/\*\*Example.+answer\*\*[:\s]*(.+)/i) ?? response.match(/Example.+answer[:\s]*(.+)/i);

    if (qMatch) {
      return {
        question: qMatch[1].trim(),
        whyItMatters: whyMatch?.[1]?.trim() ?? 'Not specified.',
        exampleAnswer: exMatch?.[1]?.trim() ?? 'Provide a concrete answer.'
      };
    }
    // Best-effort: use the entire body after the tag as the question
    const body = response.replace(/^OPEN_QUESTION:\s*/i, '').trim();
    if (body.length > 10) {
      return {
        question: body.split('\n')[0],
        whyItMatters: 'Not provided (needs clarification).',
        exampleAnswer: 'Provide a concrete answer that unblocks implementation.'
      };
    }
    return null;
  }

  /** Parse moderator summary into structured SummaryRound fields. */
  static parseSummaryFields(raw: string, agendaItemId: string): SummaryRound {
    const extractSection = (label: string): string | undefined => {
      const re = new RegExp(`${label}[:\\s]*([\\s\\S]*?)(?=\\n(?:Problem|Options|Recommendation|Risks|Actions|OpenQuestions|DecisionPromptForHuman|$))`, 'i');
      const m = raw.match(re);
      return m?.[1]?.trim() || undefined;
    };

    const extractBullets = (label: string): string[] => {
      const section = extractSection(label);
      if (!section) { return []; }
      return section.split('\n')
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
    };

    return {
      agendaItemId,
      summary: raw,
      problem: extractSection('Problem'),
      options: extractBullets('Options'),
      recommendation: extractSection('Recommendation'),
      risks: extractBullets('Risks'),
      actions: extractBullets('Actions'),
      openQuestionIds: extractBullets('OpenQuestions'),
      decisionPrompt: extractSection('DecisionPromptForHuman') ?? extractSection('Decision'),
      timestamp: new Date().toISOString()
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SYSTEM PROMPT CONSTRUCTION
  // ══════════════════════════════════════════════════════════════════════════

  private buildAgentNameMap(participants: string[], excludeId?: string): Map<string, string> {
    const nameToId = new Map<string, string>();
    for (const pid of participants) {
      if (pid === excludeId) { continue; }
      nameToId.set(pid.toLowerCase(), pid);
      const config = this.agentManager.getAgent(pid);
      if (config) {
        nameToId.set(config.name.toLowerCase(), pid);
        nameToId.set(config.name.toLowerCase().replace(/\s+/g, '-'), pid);
      }
    }
    return nameToId;
  }

  private buildAgentAwarenessContext(meeting: Meeting): string {
    const allAgents = this.agentManager.listAgents();
    const lines: string[] = ['MEETING CONTEXT:'];

    const modConfig = this.agentManager.getAgent(meeting.moderatorId ?? meeting.participants[0]);
    lines.push(`- Meeting moderator: ${modConfig?.name ?? meeting.participants[0]}`);
    lines.push(`- Human decider: The human attendee makes ALL final decisions. Agents only recommend.`);

    const participantDescs = meeting.participants.map(pid => {
      const a = this.agentManager.getAgent(pid);
      return a ? `${a.name} (${a.category})` : pid;
    });
    lines.push(`- Participants: ${participantDescs.join(', ')}`);

    lines.push('', 'ALL PROJECT AGENTS:');
    for (const a of allAgents) {
      const inMeeting = meeting.participants.includes(a.id);
      lines.push(`- ${a.name} [${a.category}]${inMeeting ? ' (in meeting)' : ''}: ${a.description}`);
    }

    return lines.join('\n');
  }

  private buildStrictMeetingRules(agentId: string, meeting: Meeting): string {
    const isModerator = agentId === (meeting.moderatorId ?? meeting.participants[0]);

    const defaultRules = `MEETING RULES (mandatory — violations will be rejected):
1. OUTPUT FORMAT: Your response MUST start with exactly ONE of these tags:
   - RECOMMENDATION: (option + rationale + tradeoffs; human decides)
   - RISK: (risk + impact + mitigation)
   - OPEN_QUESTION: (must include: **Question**, **Why it matters**, **Example acceptable answer**)
   - ACTION: (must include: **Owner role**, **Definition of Done**)
   - VALIDATION: (confirm/deny a claim; how to verify)
   - CLARIFICATION_FOR_HUMAN: (only if the human must answer to proceed — halts remaining agent turns until answered)
   - [SKIP]: <one-line reason> (if you cannot add impactful content)
2. "IMPACTFUL" means: changes a requirement, constraint, risk, interface, acceptance criteria, or decision options. If it doesn't, [SKIP].
3. BANNED — do NOT include any of:
   - Greetings or thanks ("Thank you", "Great point", "Well said")
   - Paraphrasing prior speakers unless correcting a mistake
   - Generic best practices not tied to a concrete output
   - Filler language or pleasantries of any kind
4. STRUCTURE: Use bullets. Be concise and decisive.
   - If RECOMMENDATION: include Options (A/B/C), Recommended option, Tradeoffs, What the human must decide
   - If OPEN_QUESTION: include **Question**, **Why it matters**, **Example acceptable answer**
   - If ACTION: include **Owner role**, **Definition of Done (acceptance criteria)**
5. INTERRUPTS: To request input from another agent mid-turn, add on a separate line:
   INTERRUPT_REQUEST: @agent-id — <one precise question> — Context: <1-2 lines>
   Max 2 interrupt requests per turn. Must be blocking for your output.
6. DECISIONS: You NEVER make final decisions. You recommend options + tradeoffs. The human decides.
7. PLANNING MODE (hard rule — no exceptions):
   - This meeting produces PLANS and RECOMMENDATIONS only, not implementations.
   - NEVER use past tense to claim work was completed:
     BANNED: "file is created", "I've updated", "ADR status changed to Accepted", "requirements now reflect the approved X", "I implemented"
     REQUIRED: "should create", "propose creating", "recommend updating", "needs to be done"
   - You are planning what WILL be done, not doing it.
8. DECISION GATE (hard rule — no exceptions):
   - You CANNOT mark anything as Accepted, Approved, Resolved, Done, or Finalized.
   - You CANNOT update requirements, ADRs, or docs "to reflect the approved X" — nothing is approved until the human decides.
   - If you want to advance a decision: use RECOMMENDATION: with clear A/B/C options.
   - If a clarification is missing: use CLARIFICATION_FOR_HUMAN: or OPEN_QUESTION:
   - Past decisions do NOT exist unless the human has explicitly stated them in this meeting.`;

    let rules = '\n\n' + this.loadConfig('meeting-rules.md', defaultRules);

    if (isModerator) {
      const defaultMod = `MODERATOR RESPONSIBILITIES (you are the meeting moderator):
- After all agents respond to an agenda item, you will be asked to produce a MODERATOR_SUMMARY.
- Your summary MUST use this exact structure:
  MODERATOR_SUMMARY:
  Problem: <1 line>
  Options:
  - A: ...
  - B: ...
  Recommendation: <summarized agent recommendation, if any>
  Risks:
  - ...
  Actions:
  - ...
  OpenQuestions:
  - OQ-xxxxx: ...
  DecisionPromptForHuman: <explicit choice request for the human>
- If discussion is looping, stop it: push unknowns to open questions and produce the decision prompt.`;
      rules += '\n\n' + this.loadConfig('moderator-instructions.md', defaultMod);
    }

    return rules;
  }

  private buildSystemPrompt(agentConfig: AgentConfig, meeting: Meeting): string {
    const systemPromptFiles = agentConfig.system_prompt_files ?? [];
    let systemPrompt = `You are ${agentConfig.name}. You are participating in a strict round-robin meeting titled: "${meeting.title}".\n`;
    for (const spFile of systemPromptFiles) {
      const spPath = path.join(this.workspaceRoot, '.bormagi', 'agents-definition', agentConfig.id, spFile);
      if (fs.existsSync(spPath)) {
        systemPrompt += '\n' + fs.readFileSync(spPath, 'utf8');
      }
    }

    systemPrompt += '\n\n' + this.buildAgentAwarenessContext(meeting);
    systemPrompt += this.buildStrictMeetingRules(agentConfig.id, meeting);

    return systemPrompt;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PROVIDER SETUP
  // ══════════════════════════════════════════════════════════════════════════

  private async setupProvider(agentId: string): Promise<{ provider: ReturnType<typeof ProviderFactory.create>; agentConfig: AgentConfig } | null> {
    const agentConfig = this.agentManager.getAgent(agentId);
    if (!agentConfig) { return null; }

    let effectiveProvider = agentConfig.provider;
    let apiKeyId = agentId;

    const explicitDefault = agentConfig.useDefaultProvider || !agentConfig.provider?.type;
    if (explicitDefault) {
      const def = await this.configManager.readDefaultProvider();
      if (!def?.type) { return null; }
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
    if (!apiKey && (effectiveProvider?.auth_method ?? 'api_key') === 'api_key') { return null; }

    const providerConfig = { ...agentConfig, provider: effectiveProvider };
    const provider = ProviderFactory.create(providerConfig, apiKey ?? '');
    return { provider, agentConfig };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STREAMING + REWRITE GATE
  // ══════════════════════════════════════════════════════════════════════════

  /** Stream an LLM response and return the full text. */
  private async streamResponse(
    provider: ReturnType<typeof ProviderFactory.create>,
    messages: ChatMessage[],
    onDelta?: (delta: string) => void
  ): Promise<string> {
    let full = '';
    for await (const event of provider.stream(messages, [])) {
      if (this.aborted) { break; }
      if (event.type === 'text') {
        full += event.delta;
        onDelta?.(event.delta);
      }
    }
    return full;
  }

  /**
   * Rewrite gate: if response has no valid tag, contains banned language, or contains
   * code-change claims (forbidden in planning mode), reprompt once.
   * If still invalid after one reprompt, force to [SKIP].
   */
  private async rewriteGate(
    provider: ReturnType<typeof ProviderFactory.create>,
    systemPrompt: string,
    raw: string
  ): Promise<{ response: string; tag: OutputTag; violations: string[] }> {
    let tag = this.parseTag(raw);
    const hasBanned = this.containsBannedLanguage(raw);
    const codeChangeClaim = this.containsCodeChangeClaim(raw);

    if (tag && !hasBanned && !codeChangeClaim) {
      return { response: raw, tag, violations: [] };
    }

    // Build the list of issues to report in the rewrite prompt
    const issues: string[] = [];
    if (!tag) { issues.push('Your response does not start with a valid tag.'); }
    if (hasBanned) { issues.push('Your response contains banned filler language (greetings, thanks, paraphrasing).'); }
    if (codeChangeClaim) {
      issues.push(
        `PLANNING MODE VIOLATION: Your response contains a past-tense code/work completion claim ("${codeChangeClaim}"). ` +
        `This meeting is in PLANNING MODE — you cannot claim that code was written, files were created, ` +
        `requirements were updated, or decisions were accepted. ` +
        `Rephrase as a future-tense plan or proposal (e.g. "should create", "propose to update", "recommend changing").`
      );
    }

    const defaultRewritePrompt = `REWRITE REQUIRED: {{ISSUES}}\n\nRewrite your message to comply with meeting rules:\n- Start with exactly one tag: RECOMMENDATION: | RISK: | OPEN_QUESTION: | ACTION: | VALIDATION: | CLARIFICATION_FOR_HUMAN: | [SKIP]:\n- No greetings, thanks, or filler language.\n- No past-tense completion claims — use future-tense plans.\n- Keep only impactful content. If you have nothing impactful, respond with [SKIP]: <reason>`;
    const rewriteTemplate = this.loadConfig('rewrite-prompt.md', defaultRewritePrompt);
    const rewriteUserContent = rewriteTemplate.replace('{{ISSUES}}', issues.join('\n'));

    const rewriteMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: raw },
      { role: 'user', content: rewriteUserContent }
    ];

    const rewritten = await this.streamResponse(provider, rewriteMessages);
    tag = this.parseTag(rewritten);

    // Check the rewritten response still doesn't sneak in a code-change claim
    const rewrittenCodeClaim = this.containsCodeChangeClaim(rewritten);
    const violations: string[] = [];
    if (codeChangeClaim) { violations.push(`PLANNING_MODE: ${codeChangeClaim}`); }
    if (rewrittenCodeClaim) { violations.push(`PLANNING_MODE_PERSISTS: ${rewrittenCodeClaim}`); }

    if (tag) {
      return { response: rewritten, tag, violations };
    }

    // Still invalid → force SKIP
    return { response: `[SKIP]: Could not produce compliant output.`, tag: 'SKIP', violations };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN ROUND EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  async runRound(
    meeting: Meeting,
    agendaItemId: string,
    userMessage: string | undefined,
    onDelta: RoundDeltaCallback,
    onDone: RoundDoneCallback,
    onSkip?: RoundSkipCallback,
    onInterruptDelta?: InterruptDeltaCallback,
    onInterruptDone?: InterruptDoneCallback,
    onSummary?: SummaryCallback,
    onOpenQuestion?: OpenQuestionCallback,
    /** Only run these agents (for @mention directed questions). Runs all participants if undefined. */
    targetAgentIds?: string[],
    /** Called when the item is blocked waiting for a human answer to CLARIFICATION_FOR_HUMAN. */
    onBlockedForHuman?: BlockedForHumanCallback
  ): Promise<void> {
    this.resetAbort();
    const item = meeting.agenda.find(a => a.id === agendaItemId);
    if (!item) { return; }

    // If human provided input, unblock the item
    if (item.blockedByHuman && userMessage) {
      item.blockedByHuman = false;
    }

    // If item is still blocked (no human input provided), notify and bail
    if (item.blockedByHuman && !userMessage) {
      onBlockedForHuman?.(agendaItemId);
      return;
    }

    const resourceContext = this.loadResourceFiles(meeting.resourceFiles);

    // Use targeted agents (for @mention directed questions) or the full participant list
    const agentsToRun = targetAgentIds && targetAgentIds.length > 0
      ? meeting.participants.filter(id => targetAgentIds.includes(id))
      : meeting.participants;

    for (const agentId of agentsToRun) {
      if (this.aborted) { break; }

      const setup = await this.setupProvider(agentId);
      if (!setup) { continue; }
      const { provider, agentConfig } = setup;

      const systemPrompt = this.buildSystemPrompt(agentConfig, meeting);

      // Build conversation
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt }
      ];

      if (resourceContext) {
        messages.push({ role: 'user', content: `[Meeting Resources]\n${resourceContext}` });
        messages.push({ role: 'assistant', content: 'Understood.' });
      }

      // Prior rounds context (non-skipped, with tags)
      const priorRounds = meeting.rounds.filter(r => r.agendaItemId === agendaItemId && !r.skipped);
      if (priorRounds.length > 0) {
        const priorText = priorRounds.map(r => {
          const name = this.agentManager.getAgent(r.agentId)?.name ?? r.agentId;
          const tagLabel = r.tag ? `[${r.tag}]` : '';
          const prefix = r.isInterrupt
            ? `↳ ${name} ${tagLabel} (interrupt responding to ${r.triggeredBy})`
            : `${name} ${tagLabel}`;
          return `${prefix}: ${r.response}`;
        }).join('\n\n');
        messages.push({ role: 'user', content: `[Discussion so far]\n${priorText}` });
        messages.push({ role: 'assistant', content: 'Noted.' });
      }

      // Prior summaries
      const priorSummaries = (meeting.summaryRounds ?? []).filter(s => s.agendaItemId === agendaItemId);
      if (priorSummaries.length > 0) {
        const summaryText = priorSummaries.map(s => s.summary).join('\n\n');
        messages.push({ role: 'user', content: `[Moderator summary]\n${summaryText}` });
        messages.push({ role: 'assistant', content: 'Noted.' });
      }

      // The prompt
      let prompt = `Agenda item: "${item.text}"\n\n`;
      if (userMessage) {
        prompt += `The human decider has responded: "${userMessage}"\n\n`;
      }
      // Inform agents if the item had been blocked (human just answered)
      if (userMessage && !item.blockedByHuman) {
        prompt += `Note: The human has provided a response to a previous clarification question. Factor this in.\n\n`;
      }
      prompt += `Your turn. Respond with exactly one output tag. If you have nothing impactful to add, respond with [SKIP]: <reason>.`;
      messages.push({ role: 'user', content: prompt });

      // Stream response
      let fullResponse = await this.streamResponse(provider, messages, (delta) => {
        onDelta(agendaItemId, agentId, delta);
      });

      // Rewrite gate — enforces tags, bans talkshop language, and blocks code-change claims (planning mode)
      const { response: validated, tag } = await this.rewriteGate(provider, systemPrompt, fullResponse);
      if (validated !== fullResponse) {
        fullResponse = validated;
      }

      const isSkip = tag === 'SKIP';
      const skipReason = isSkip ? fullResponse.replace(/^\[SKIP\][:\s]*/i, '').trim() : '';

      // Parse interrupt requests (only from non-skip turns)
      const interruptReqs = isSkip ? [] : this.extractInterruptRequests(fullResponse, meeting.participants, agentId);

      // Create round
      const round: MeetingRound = {
        agendaItemId,
        agentId,
        response: fullResponse,
        timestamp: new Date().toISOString(),
        tag,
        skipped: isSkip || undefined,
        interruptRequests: interruptReqs.length > 0 ? interruptReqs : undefined,
      };
      meeting.rounds.push(round);

      // Callbacks
      if (isSkip) {
        onSkip?.(agendaItemId, agentId, skipReason);
      }
      onDone(agendaItemId, agentId, fullResponse, tag);

      // CLARIFICATION_FOR_HUMAN: block item and stop remaining agents — wait for human
      if (tag === 'CLARIFICATION_FOR_HUMAN' && !this.aborted) {
        item.blockedByHuman = true;
        onBlockedForHuman?.(agendaItemId);
        break; // Do not call remaining agents — they must wait for the human's answer
      }

      // Handle OPEN_QUESTION: append to OQ file
      if (tag === 'OPEN_QUESTION' && !this.aborted) {
        await this.handleOpenQuestion(meeting, agendaItemId, agentId, fullResponse, onOpenQuestion);
      }

      // Handle interrupt requests
      if (interruptReqs.length > 0 && !this.aborted) {
        for (const req of interruptReqs) {
          if (this.aborted) { break; }
          await this.runInterrupt(
            meeting, agendaItemId, agentId, req,
            onDelta, onInterruptDelta, onInterruptDone, onOpenQuestion
          );
        }
      }
    }

    // Only generate moderator summary when the round completed normally (not blocked waiting for human)
    if (!this.aborted && !item.blockedByHuman && onSummary) {
      const summary = await this.generateStructuredSummary(meeting, agendaItemId);
      if (summary) {
        onSummary(agendaItemId, summary);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  OPEN QUESTION HANDLING
  // ══════════════════════════════════════════════════════════════════════════

  private async handleOpenQuestion(
    meeting: Meeting,
    agendaItemId: string,
    agentId: string,
    response: string,
    onOpenQuestion?: OpenQuestionCallback
  ): Promise<void> {
    const parsed = MeetingOrchestrator.parseOpenQuestion(response);
    if (!parsed) { return; }

    const oqId = this.storage.nextOpenQuestionId(meeting);
    const agentName = this.agentManager.getAgent(agentId)?.name ?? agentId;
    const item = meeting.agenda.find(a => a.id === agendaItemId);

    const defaultTemplate = `### {{OQ_ID}}: {{QUESTION}}\n- Agenda item: {{AGENDA_ITEM}}\n- Asked by: {{ASKED_BY}}\n- Why it matters: {{WHY_IT_MATTERS}}\n- Example acceptable answer: {{EXAMPLE_ANSWER}}\n- Answer: _pending_\n`;
    const template = this.loadConfig('oq-template.md', defaultTemplate);

    const block = template
      .replace(/\{\{OQ_ID\}\}/g, oqId)
      .replace(/\{\{QUESTION\}\}/g, parsed.question)
      .replace(/\{\{AGENDA_ITEM\}\}/g, item?.text ?? agendaItemId)
      .replace(/\{\{ASKED_BY\}\}/g, agentName)
      .replace(/\{\{WHY_IT_MATTERS\}\}/g, parsed.whyItMatters)
      .replace(/\{\{EXAMPLE_ANSWER\}\}/g, parsed.exampleAnswer);

    await this.storage.appendOpenQuestionBlock(meeting.id, block);

    if (!meeting.openQuestionsCreated) { meeting.openQuestionsCreated = []; }
    meeting.openQuestionsCreated.push(oqId);

    onOpenQuestion?.(agendaItemId, oqId, parsed.question, agentId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERRUPT EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  private async runInterrupt(
    meeting: Meeting,
    agendaItemId: string,
    callerAgentId: string,
    req: InterruptRequest,
    _onDelta: RoundDeltaCallback,
    onInterruptDelta?: InterruptDeltaCallback,
    onInterruptDone?: InterruptDoneCallback,
    onOpenQuestion?: OpenQuestionCallback
  ): Promise<void> {
    const targetAgentId = req.mentionedAgentId;
    const setup = await this.setupProvider(targetAgentId);
    if (!setup) { return; }
    const { provider, agentConfig } = setup;

    const systemPrompt = this.buildSystemPrompt(agentConfig, meeting);
    const callerName = this.agentManager.getAgent(callerAgentId)?.name ?? callerAgentId;

    const defaultInterrupt = `{{CALLER_NAME}} has directed a question to you via INTERRUPT_REQUEST.\n\nQuestion: {{QUESTION}}\n{{CONTEXT_LINE}}\n\nRespond with exactly ONE tag (VALIDATION: | RECOMMENDATION: | OPEN_QUESTION: | [SKIP]:).\nAnswer ONLY the asked question. Be short and decisive. Do NOT introduce new topics.`;
    const template = this.loadConfig('interrupt-prompt.md', defaultInterrupt);
    const prompt = template
      .replace(/\{\{CALLER_NAME\}\}/g, callerName)
      .replace(/\{\{QUESTION\}\}/g, req.question)
      .replace(/\{\{CONTEXT_LINE\}\}/g, req.context ? `Context: ${req.context}` : '');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];

    let fullResponse = await this.streamResponse(provider, messages, (delta) => {
      onInterruptDelta?.(agendaItemId, targetAgentId, callerAgentId, delta);
    });

    // Rewrite gate for interrupt too
    const { response: validated, tag } = await this.rewriteGate(provider, systemPrompt, fullResponse);
    if (validated !== fullResponse) { fullResponse = validated; }

    const round: MeetingRound = {
      agendaItemId,
      agentId: targetAgentId,
      response: fullResponse,
      timestamp: new Date().toISOString(),
      tag,
      isInterrupt: true,
      triggeredBy: callerAgentId,
      skipped: tag === 'SKIP' || undefined,
    };
    meeting.rounds.push(round);

    onInterruptDone?.(agendaItemId, targetAgentId, callerAgentId, fullResponse, tag);

    // Handle OPEN_QUESTION from interrupt
    if (tag === 'OPEN_QUESTION') {
      await this.handleOpenQuestion(meeting, agendaItemId, targetAgentId, fullResponse, onOpenQuestion);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STRUCTURED MODERATOR SUMMARY
  // ══════════════════════════════════════════════════════════════════════════

  async generateStructuredSummary(
    meeting: Meeting,
    agendaItemId: string
  ): Promise<SummaryRound | null> {
    const moderatorId = meeting.moderatorId ?? meeting.participants[0];
    const setup = await this.setupProvider(moderatorId);
    if (!setup) { return null; }
    const { provider, agentConfig } = setup;

    const item = meeting.agenda.find(a => a.id === agendaItemId);
    if (!item) { return null; }

    const rounds = meeting.rounds.filter(r =>
      r.agendaItemId === agendaItemId && !r.skipped
    );
    if (rounds.length === 0) { return null; }

    const discussionText = rounds.map(r => {
      const name = this.agentManager.getAgent(r.agentId)?.name ?? r.agentId;
      const tagLabel = r.tag ? `[${r.tag}]` : '';
      const prefix = r.isInterrupt ? `↳ ${name} ${tagLabel} (interrupt)` : `${name} ${tagLabel}`;
      return `${prefix}: ${r.response}`;
    }).join('\n\n');

    // Collect OQ IDs created during this item
    const itemOqIds = (meeting.openQuestionsCreated ?? []).filter(id =>
      meeting.rounds.some(r => r.agendaItemId === agendaItemId && r.tag === 'OPEN_QUESTION')
    );
    const oqList = itemOqIds.length > 0 ? itemOqIds.join(', ') : 'None';

    const defaultSummary = `You are {{MODERATOR_NAME}}, the meeting moderator.\nProduce a structured summary. No filler language. No code blocks.\nYou MUST use this EXACT format:\n\nMODERATOR_SUMMARY:\nProblem: <1 line>\nOptions:\n- A: ...\n- B: ...\nRecommendation: <summarized recommendation, if any>\nRisks:\n- ...\nActions:\n- ...\nOpenQuestions:\n- {{OPEN_QUESTION_IDS}}\nDecisionPromptForHuman: <explicit choice request>`;
    const template = this.loadConfig('summary-prompt.md', defaultSummary);
    const systemContent = template
      .replace(/\{\{MODERATOR_NAME\}\}/g, agentConfig.name)
      .replace(/\{\{OPEN_QUESTION_IDS\}\}/g, oqList);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      {
        role: 'user', content:
          `Agenda item: "${item.text}"\n\n` +
          `Discussion:\n${discussionText}\n\n` +
          `Produce your MODERATOR_SUMMARY now.`
      }
    ];

    const raw = await this.streamResponse(provider, messages);
    const summary = MeetingOrchestrator.parseSummaryFields(raw, agendaItemId);

    if (!meeting.summaryRounds) { meeting.summaryRounds = []; }
    meeting.summaryRounds.push(summary);

    return summary;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MINUTES GENERATION
  // ══════════════════════════════════════════════════════════════════════════

  async generateMinutes(meeting: Meeting): Promise<string> {
    const lines: string[] = [
      `# Meeting Minutes: ${meeting.title}`,
      `**Date:** ${new Date(meeting.created_at).toLocaleString()}`,
      `**Moderator:** ${this.agentManager.getAgent(meeting.moderatorId ?? meeting.participants[0])?.name ?? meeting.participants[0]}`,
      `**Participants:** ${meeting.participants.map(p => this.agentManager.getAgent(p)?.name ?? p).join(', ')}`,
      ''
    ];

    for (const item of meeting.agenda) {
      lines.push(`## ${item.text}`);
      lines.push(`**Status:** ${item.status}`);
      if (item.decision) { lines.push(`**Decision:** ${item.decision}`); }
      lines.push('');

      const rounds = meeting.rounds.filter(r => r.agendaItemId === item.id);
      for (const round of rounds) {
        const agentName = this.agentManager.getAgent(round.agentId)?.name ?? round.agentId;
        const tagLabel = round.tag ? `[${round.tag}]` : '';

        if (round.skipped) {
          lines.push(`- ${agentName} skipped: ${round.response.replace(/^\[SKIP\][:\s]*/i, '').trim()}`);
          continue;
        }

        if (round.isInterrupt) {
          const callerName = this.agentManager.getAgent(round.triggeredBy ?? '')?.name ?? round.triggeredBy ?? '';
          lines.push(`↳ ${agentName} ${tagLabel} (interrupt responding to @${callerName})`);
        } else {
          lines.push(`### ${agentName} ${tagLabel}`);
        }
        lines.push(round.response);
        lines.push('');
      }

      // Moderator summary
      const summaries = (meeting.summaryRounds ?? []).filter(s => s.agendaItemId === item.id);
      if (summaries.length > 0) {
        const s = summaries[summaries.length - 1];
        lines.push('### Moderator Summary');
        if (s.problem) { lines.push(`Problem: ${s.problem}`); }
        if (s.options?.length) {
          lines.push('Options:');
          s.options.forEach(o => lines.push(`- ${o}`));
        }
        if (s.recommendation) { lines.push(`Recommendation: ${s.recommendation}`); }
        if (s.risks?.length) {
          lines.push('Risks:');
          s.risks.forEach(r => lines.push(`- ${r}`));
        }
        if (s.actions?.length) {
          lines.push('Actions:');
          s.actions.forEach(a => lines.push(`- ${a}`));
        }
        if (s.decisionPrompt) { lines.push(`\n**Decision for Human:** ${s.decisionPrompt}`); }
        lines.push('');
      }
    }

    // Action items
    if (meeting.actionItems.length > 0) {
      lines.push('## Action Items');
      for (const ai of meeting.actionItems) {
        lines.push(`- **${ai.assignedTo}:** ${ai.text}`);
      }
      lines.push('');
    }

    // Open questions
    if ((meeting.openQuestionsCreated ?? []).length > 0) {
      lines.push('## Open Questions');
      lines.push(`See open_questions.md (${meeting.openQuestionsCreated!.length} questions created)`);
      lines.push('');
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
