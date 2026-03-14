import type { ChatMessage } from '../../types';
import { sanitiseTranscript } from './TranscriptSanitiser';

/**
 * Input context for building a compact LLM message array.
 * All fields are plain strings — no raw history turns.
 */
export interface PromptContext {
  /** Stable agent system prompt. Sent on every call (providers are stateless). */
  systemPrompt: string;
  /** Compact execution-state block: objective, iterations, nextAction, files written. */
  executionStateSummary: string;
  /** Compact workspace summary: type (greenfield/mature) and up to 3 key files. */
  workspaceSummary: string;
  /** Current user instruction or run objective. */
  currentInstruction: string;
  /** Tool result messages from the CURRENT iteration only — no prior turns. */
  currentStepToolResults: ChatMessage[];
  /**
   * Optional one-line prior milestone summary for continuation context.
   * Used only on resume when nextAction is being executed.
   */
  milestoneSummary?: string;
}

/**
 * Builds a compact, flat message array for each LLM call in code mode.
 *
 * Design (EQ-15, Option A):
 *   - Zero prior conversation turns in code mode by default.
 *   - System prompt sent on every call (provider sessions are stateless).
 *   - Tool results from the current step only — not replayed history.
 *   - Runs sanitiseTranscript() on the final array before returning.
 *
 * This replaces the full-history replay pattern that caused the token
 * explosion observed in the advanced-coder log (calls #1–#9 each included
 * the entire 5 444-char system prompt + full conversation history).
 */
export class PromptAssembler {
  private readonly executionStateHeader: string;
  private readonly workspaceHeader: string;
  private readonly milestoneSummaryPrefix: string;

  constructor(messages: { executionStateHeader: string; workspaceHeader: string; milestoneSummaryPrefix: string }) {
    this.executionStateHeader = messages.executionStateHeader;
    this.workspaceHeader = messages.workspaceHeader;
    this.milestoneSummaryPrefix = messages.milestoneSummaryPrefix;
  }

  /**
   * Assemble a compact message array for a single LLM call.
   * Output order:
   *   1. system: stable system prompt
   *   2. system: compact execution-state summary
   *   3. system: compact workspace summary
   *   4. assistant: prior milestone summary (if provided)
   *   5. user: current instruction
   *   6. tool_result messages from the current step
   */
  assembleMessages(ctx: PromptContext): ChatMessage[] {
    const msgs: ChatMessage[] = [];

    // 1. Stable system prompt
    msgs.push({ role: 'system', content: ctx.systemPrompt });

    // 2. Compact execution state
    if (ctx.executionStateSummary) {
      msgs.push({
        role: 'system',
        content: `${this.executionStateHeader}\n${ctx.executionStateSummary}`,
      });
    }

    // 3. Compact workspace summary
    if (ctx.workspaceSummary) {
      msgs.push({
        role: 'system',
        content: `${this.workspaceHeader}\n${ctx.workspaceSummary}`,
      });
    }

    // 4. Optional prior milestone (one line max)
    if (ctx.milestoneSummary) {
      msgs.push({
        role: 'assistant',
        content: `${this.milestoneSummaryPrefix}${ctx.milestoneSummary}`,
      });
    }

    // 5. Current user instruction
    msgs.push({ role: 'user', content: ctx.currentInstruction });

    // 6. Current-step tool results only
    for (const tr of ctx.currentStepToolResults) {
      msgs.push(tr);
    }

    // Sanitise before returning — defence in depth
    return sanitiseTranscript(msgs);
  }
}

/**
 * Build a compact workspace summary string.
 * Used in PromptContext.workspaceSummary.
 */
export function buildWorkspaceSummary(
  type: 'greenfield' | 'scaffolded' | 'mature',
  keyFiles: string[]
): string {
  if (type === 'greenfield') {
    return '[Greenfield] No project scaffold yet. Start by creating package.json and src/.';
  }
  const files = keyFiles.slice(0, 5).join(', ');
  return type === 'scaffolded'
    ? `[Scaffolded] Early-stage project. Key files: ${files || 'none'}.`
    : `[Mature] Existing codebase. Read key files before modifying. Key files: ${files || 'none'}.`;
}
