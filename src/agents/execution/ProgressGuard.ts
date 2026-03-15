/**
 * ProgressGuard — Tracks productive vs non-productive turns.
 *
 * Bug-fix004 item 15: After N non-progress turns, recovery is mandatory.
 *
 * Progress = successful write/edit, successful validation, batch advance,
 *            explicit terminal state.
 * Non-progress = narration only, repeated blocked read, repeated batch
 *                declaration, repeated workspace inspection with no state change.
 */

export interface ProgressState {
  /** Count of consecutive non-progress turns. */
  nonProgressCount: number;
  /** Timestamp of last productive action. */
  lastProgressAt?: string;
  /** Reason for last non-progress classification. */
  lastNonProgressReason?: string;
}

export type ProgressVerdict = 'PROGRESS' | 'NON_PROGRESS' | 'RECOVERY_REQUIRED';

/** Tools that count as productive mutations. */
const PROGRESS_TOOLS = new Set([
  'write_file', 'edit_file', 'multi_edit',
  'declare_file_batch', 'update_task_state',
  'create_document', 'create_presentation',
]);

/** Maximum non-progress turns before forced recovery. */
const MAX_NON_PROGRESS = 3;

export class ProgressGuard {
  private state: ProgressState;

  constructor(initialState?: Partial<ProgressState>) {
    this.state = {
      nonProgressCount: initialState?.nonProgressCount ?? 0,
      lastProgressAt: initialState?.lastProgressAt,
      lastNonProgressReason: initialState?.lastNonProgressReason,
    };
  }

  /**
   * Evaluate whether the last turn made progress.
   *
   * @param calledATool  Whether a tool was called this turn.
   * @param toolName     Name of the tool called (if any).
   * @param toolStatus   Status from ToolDispatcher ('success', 'blocked', 'cached', etc.).
   * @param hadTextOnly  Whether the LLM produced only narration text.
   */
  evaluate(
    calledATool: boolean,
    toolName?: string,
    toolStatus?: string,
    hadTextOnly?: boolean,
  ): ProgressVerdict {
    // Successful mutation tool = progress
    if (calledATool && toolName && PROGRESS_TOOLS.has(toolName) && toolStatus === 'success') {
      this.state.nonProgressCount = 0;
      this.state.lastProgressAt = new Date().toISOString();
      this.state.lastNonProgressReason = undefined;
      return 'PROGRESS';
    }

    // Blocked/cached reads, narration-only turns = non-progress
    let reason: string;
    if (hadTextOnly && !calledATool) {
      reason = 'narration_only';
    } else if (toolStatus === 'blocked') {
      reason = `blocked_${toolName ?? 'unknown'}`;
    } else if (toolStatus === 'cached') {
      reason = `cached_read_${toolName ?? 'unknown'}`;
    } else if (calledATool && toolName && !PROGRESS_TOOLS.has(toolName)) {
      // Read/list tools are not progress during batch execution
      reason = `non_mutation_tool_${toolName}`;
    } else {
      reason = 'unknown_non_progress';
    }

    this.state.nonProgressCount++;
    this.state.lastNonProgressReason = reason;

    if (this.state.nonProgressCount >= MAX_NON_PROGRESS) {
      return 'RECOVERY_REQUIRED';
    }

    return 'NON_PROGRESS';
  }

  /** Reset after successful recovery. */
  reset(): void {
    this.state.nonProgressCount = 0;
    this.state.lastNonProgressReason = undefined;
  }

  getState(): Readonly<ProgressState> {
    return { ...this.state };
  }
}
