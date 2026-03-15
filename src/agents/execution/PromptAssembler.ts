import type { ChatMessage } from '../../types';
import { sanitiseTranscript } from './TranscriptSanitiser';
import { loadSkillFragment } from '../../skills/skillLoader';

// ─── Protocol leak detection ──────────────────────────────────────────────────

const PROTOCOL_LEAK_PATTERNS: RegExp[] = [
  /<tool_result/i,
  /\[write_file:/i,
  /\[edit_file:/i,
  /^TOOL:/m,
  /\[ASSISTANT\]/,
];

/**
 * Asserts that no assembled message contains protocol-layer syntax.
 * In development/test (NODE_ENV !== 'production') this throws.
 * In production it logs a warning but proceeds (defence in depth).
 */
function assertNoProtocolLeak(messages: ChatMessage[]): void {
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    for (const pattern of PROTOCOL_LEAK_PATTERNS) {
      if (pattern.test(content)) {
        const err = `[PromptAssembler] Protocol leak in ${msg.role} message: pattern ${pattern}`;
        if (process.env['NODE_ENV'] !== 'production') {
          throw new Error(err);
        }
        console.warn(err);
        return;
      }
    }
  }
}

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
  /**
   * Optional list of skill fragment names to inject as system messages.
   * Each skill is loaded from src/skills/<name>.md at runtime.
   * Skills appear as system messages between the workspace summary and user instruction.
   */
  activeSkills?: string[];
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
   *   4. system: skill fragments (one per active skill, if any)
   *   5. assistant: prior milestone summary (if provided)
   *   6. user: current instruction
   *   7. tool_result messages from the current step
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

    // 4. Skill fragments (loaded at runtime from src/skills/)
    if (ctx.activeSkills && ctx.activeSkills.length > 0) {
      for (const skillName of ctx.activeSkills) {
        const fragment = loadSkillFragment(skillName);
        if (fragment) {
          msgs.push({ role: 'system', content: fragment });
        }
      }
    }

    // 5. Optional prior milestone (one line max)
    if (ctx.milestoneSummary) {
      msgs.push({
        role: 'assistant',
        content: `${this.milestoneSummaryPrefix}${ctx.milestoneSummary}`,
      });
    }

    // 6. Current user instruction
    msgs.push({ role: 'user', content: ctx.currentInstruction });

    // 7. Current-step tool results only
    // Convert tool_result role → user role (API only accepts system/user/assistant/tool).
    // Strip XML <tool_result> wrappers — matches prepareMessagesForProvider() behaviour.
    for (const tr of ctx.currentStepToolResults) {
      if (tr.role === 'tool_result') {
        const inner = tr.content
          .replace(/<tool_result[^>]*>\n?/g, '')
          .replace(/\n?<\/tool_result>/g, '')
          .trim();
        if (inner) {
          msgs.push({ role: 'user', content: inner });
        }
      } else {
        msgs.push(tr);
      }
    }

    // Sanitise before returning — defence in depth
    const sanitised = sanitiseTranscript(msgs);
    // Validate that sanitisation removed all protocol noise
    assertNoProtocolLeak(sanitised);
    return sanitised;
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
    return '[Greenfield] No runnable code scaffold yet. Documentation may exist. Start by declaring the file batch and writing the first scaffold file.';
  }
  const files = keyFiles.slice(0, 5).join(', ');
  return type === 'scaffolded'
    ? `[Scaffolded] Early-stage project. Key files: ${files || 'none'}.`
    : `[Mature] Existing codebase. Read key files before modifying. Key files: ${files || 'none'}.`;
}
