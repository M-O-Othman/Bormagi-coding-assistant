import type { ChatMessage } from '../../types';
import { ExecutionStateManager, type ExecutionStateData } from '../ExecutionStateManager';
import { sanitiseContent } from './TranscriptSanitiser';
import { PromptAssembler, buildWorkspaceSummary } from './PromptAssembler';

/** All five recovery triggers from EQ-18. */
export type RecoveryTrigger =
  | 'REPEATED_BLOCKED_READS'
  | 'REPEATED_CONTINUE_NO_PROGRESS'
  | 'ARTIFACT_WRITE_CONFLICT'
  | 'PROTOCOL_TEXT_IN_TRANSCRIPT'
  | 'MISSING_NEXT_ACTION';

export interface RecoveryResult {
  success: boolean;
  trigger: RecoveryTrigger;
  summary: string;
  /** Replacement clean message array (populated on success). */
  cleanMessages?: ChatMessage[];
}

/**
 * Detects execution-state inconsistencies and rebuilds compact context
 * from the authoritative executed-tools log.
 *
 * Design (EQ-18, A1 + B2):
 *   - Checks all 5 triggers before each LLM call.
 *   - On trigger: rebuild from executedTools[], replace message array,
 *     show brief notice, continue automatically.
 *   - On failed rebuild: set RECOVERY_REQUIRED.
 */
export class RecoveryManager {
  constructor(
    private readonly execState: ExecutionStateData,
    private readonly messages: ChatMessage[],
    private readonly promptAssembler: PromptAssembler,
    private readonly systemPrompt: string,
    private readonly workspaceType: 'greenfield' | 'scaffolded' | 'mature',
    private readonly stateManager?: ExecutionStateManager,
  ) {}

  /** Check all 5 triggers. Returns the first matching trigger, or null. */
  shouldRecover(): RecoveryTrigger | null {
    // Trigger 1: repeated blocked reads
    if ((this.execState.blockedReadCount ?? 0) >= 3) {
      return 'REPEATED_BLOCKED_READS';
    }

    // Trigger 2: repeated continue with no progress
    const continueCount = this.execState.continueCount ?? 0;
    const snapshot = this.execState.continueIterationSnapshot ?? 0;
    if (continueCount >= 2 && this.execState.iterationsUsed === snapshot) {
      return 'REPEATED_CONTINUE_NO_PROGRESS';
    }

    // Trigger 3: protocol text detected in the transcript
    if (this._hasProtocolText()) {
      return 'PROTOCOL_TEXT_IN_TRANSCRIPT';
    }

    // Trigger 4: nextAction is missing/empty while run is still active.
    // Only fire after 5+ iterations so agents have room to work before being required
    // to call update_task_state. Firing on iteration 1-4 causes unnecessary churn.
    if (
      (this.execState.runPhase ?? 'RUNNING') === 'RUNNING' &&
      this.execState.iterationsUsed >= 5 &&
      (this.execState.nextActions ?? []).length === 0 &&
      !this.execState.nextToolCall &&
      this.execState.artifactsCreated.length === 0
    ) {
      return 'MISSING_NEXT_ACTION';
    }

    // Trigger 5: ARTIFACT_WRITE_CONFLICT is detected inline in ToolDispatcher
    // and communicated by setting blockedReadCount; no separate check here.

    return null;
  }

  /**
   * Rebuild compact context from the executed-tools ground truth.
   * Returns a replacement clean message array and a summary string.
   */
  rebuild(trigger: RecoveryTrigger): RecoveryResult {
    try {
      const executedTools = this.execState.executedTools ?? [];
      const filesWritten = this.execState.artifactsCreated;
      const filesRead = this.execState.resolvedInputs;
      const lastTool = this.execState.lastExecutedTool ?? 'none';

      const stateSummary = this.execState.iterationsUsed > 0
        ? [
          `Objective: ${this.execState.objective.slice(0, 200)}`,
          `Iterations completed: ${this.execState.iterationsUsed}`,
          `Last tool executed: ${lastTool}`,
          filesWritten.length > 0 ? `Files written: ${filesWritten.slice(-5).join(', ')}` : '',
          filesRead.length > 0 ? `Files read: ${filesRead.slice(-3).join(', ')}` : '',
          `Recovery trigger: ${trigger}`,
        ].filter(Boolean).join('\n')
        : `Objective: ${this.execState.objective.slice(0, 200)}\n(No tools executed yet.)`;

      // DD6: Use deterministic next-step synthesis first, then fall back.
      // For REPEATED_BLOCKED_READS, never emit read/start-over instructions.
      let nextActionHint: string;
      const deterministic = this.stateManager?.computeDeterministicNextStep(this.execState, this.workspaceType);
      if (deterministic?.nextToolCall) {
        nextActionHint = deterministic.nextAction;
        // Store the tool call so controller can dispatch directly
        this.execState.nextToolCall = deterministic.nextToolCall;
      } else if (this.execState.nextToolCall?.description) {
        nextActionHint = this.execState.nextToolCall.description;
      } else if ((this.execState.nextActions ?? []).length > 0) {
        nextActionHint = this.execState.nextActions[0];
      } else if (deterministic?.nextAction) {
        nextActionHint = deterministic.nextAction;
      } else if (lastTool !== 'none') {
        // Derive from workspace type + last tool executed
        if (this.workspaceType === 'greenfield' && filesWritten.length === 0) {
          nextActionHint = 'Declare a file batch, then write the first file';
        } else if (filesWritten.length > 0) {
          nextActionHint = `Continue from last written file: ${filesWritten[filesWritten.length - 1]}`;
        } else {
          nextActionHint = 'Write or edit the next file based on the objective';
        }
      } else {
        nextActionHint = filesWritten.length > 0
          ? `Continue from last written file: ${filesWritten[filesWritten.length - 1]}`
          : 'Declare file batch and write the first implementation file';
      }

      const lastToolEntry = executedTools[executedTools.length - 1];
      const milestoneSummary = lastToolEntry
        ? `Last tool: ${lastToolEntry.name}${lastToolEntry.inputPath ? ` on ${lastToolEntry.inputPath}` : ''}`
        : undefined;

      const keyFiles = filesWritten.slice(-3);
      const workspaceSummary = buildWorkspaceSummary(this.workspaceType, keyFiles);

      const cleanMessages = this.promptAssembler.assembleMessages({
        systemPrompt: this.systemPrompt,
        executionStateSummary: stateSummary,
        workspaceSummary,
        currentInstruction: nextActionHint,
        currentStepToolResults: [],
        milestoneSummary,
      });

      return {
        success: true,
        trigger,
        summary: `Recovery (${trigger}): rebuilt from ${executedTools.length} executed tools.`,
        cleanMessages,
      };
    } catch {
      return {
        success: false,
        trigger,
        summary: `Recovery (${trigger}) failed — cannot rebuild context.`,
      };
    }
  }

  private _hasProtocolText(): boolean {
    // Patterns that indicate genuine protocol text leaking into conversational messages.
    // These should only fire on LLM-generated text that mimics tool protocol syntax,
    // NOT on framework-generated labels or tool outputs.
    const PROTOCOL_PATTERNS = [
      /\[write_file:/,
      /\[edit_file:/,
      /<tool_result/,
      /TOOL:(?:read_file|list_files|write_file|search_files):/,
    ];
    for (const msg of this.messages) {
      // tool_result messages legitimately contain <tool_result> XML, [BLOCKED] prefixes,
      // [BATCH VIOLATION] etc. — these are valid tool outputs, not protocol leaks.
      if (msg.role === 'tool_result') { continue; }
      // system messages are framework-generated (system prompt, execution state, etc.)
      // and never contain LLM-generated protocol leaks.
      if (msg.role === 'system') { continue; }

      // Strip null-byte sentinels from assistant messages before checking.
      // \x00TOOL:name:{...}\x00 is how AgentRunner labels tool calls with no text —
      // it is expected and is NOT a protocol leak. sanitiseContent also strips these,
      // so they must be excluded before we call the sanitiseContent divergence check.
      const content = msg.content.replace(/\x00TOOL:[^\x00]*\x00/g, '').trim();
      if (!content) { continue; }

      for (const pattern of PROTOCOL_PATTERNS) {
        if (pattern.test(content)) { return true; }
      }
      if (sanitiseContent(content) !== content) { return true; }
    }
    return false;
  }
}
