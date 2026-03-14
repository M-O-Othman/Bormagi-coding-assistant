import type { ChatMessage } from '../../types';
import type { ExecutionStateData } from '../ExecutionStateManager';
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

    // Trigger 4: nextAction is missing/empty while run is still active
    if (
      (this.execState.runPhase ?? 'RUNNING') === 'RUNNING' &&
      this.execState.iterationsUsed > 0 &&
      (this.execState.nextActions ?? []).length === 0 &&
      !this.execState.nextToolCall
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

      // Determine what the next action should be
      const nextActionHint = filesWritten.length > 0
        ? `Continue from last written file: ${filesWritten[filesWritten.length - 1]}`
        : `Start implementation from the beginning`;

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
    const PROTOCOL_PATTERNS = [
      /\[write_file:/,
      /\[edit_file:/,
      /\x00TOOL:/,
      /<tool_result/,
      /TOOL:(?:read_file|list_files|write_file|search_files):/,
    ];
    for (const msg of this.messages) {
      for (const pattern of PROTOCOL_PATTERNS) {
        if (pattern.test(msg.content)) {
          return true;
        }
      }
    }
    // Also check if sanitiseContent would change any message (protocol noise present)
    return this.messages.some(m => sanitiseContent(m.content) !== m.content);
  }
}
