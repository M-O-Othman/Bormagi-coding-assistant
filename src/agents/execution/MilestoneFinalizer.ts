import type { ExecutionStateData } from '../ExecutionStateManager';
import { TASK_TEMPLATES } from './TaskTemplate';

/**
 * Deterministic per-step decision after a tool execution.
 *
 * Checks post-write rules strictly:
 *   1. stopAfterWrite template → COMPLETE
 *   2. full batch written → VALIDATE
 *   3. write to a wait-keyword file + objective contains "wait" → WAIT (unless batch is active)
 *   4. default → CONTINUE
 */
export type MilestoneDecision =
  | { action: 'CONTINUE' }
  | { action: 'VALIDATE'; reason: string }
  | { action: 'WAIT'; message: string }
  | { action: 'COMPLETE'; message: string }
  | { action: 'BLOCK'; reason: string; recoverable: boolean };

/** File-name patterns that suggest the agent wrote a deliverable requiring user input. */
const WAIT_FILENAME_PATTERNS = [
  /open[_-]?questions/i,
  /questions/i,
  /review[_-]?request/i,
  /plan\.(md|txt)$/i,
  /proposal\.(md|txt)$/i,
];

/** Objective keywords that indicate the user wants the agent to pause and wait. */
const WAIT_OBJECTIVE_KEYWORDS = /\b(wait|document\s+then\s+wait|document and wait|pause after|stop after|draft then wait)\b/i;

/** Messages strings injected from data/execution-messages.json by AgentRunner. */
export interface MilestoneMessages {
  waitAutoDetected: string;
  batchCheckpoint: string;
  batchComplete: string;
}

export class MilestoneFinalizer {
  constructor(private readonly messages: MilestoneMessages) {}

  /**
   * Decide what to do after a step completes.
   *
   * @param state            Current execution state.
   * @param lastToolName     Name of the tool just executed.
   * @param lastToolPath     Path argument of the tool (for write/edit tools).
   */
  decide(
    state: ExecutionStateData,
    lastToolName: string,
    lastToolPath?: string,
  ): MilestoneDecision {
    const planned = state.plannedFileBatch ?? [];
    const completed = state.completedBatchFiles ?? [];
    const batchRemaining = planned.length > 0
      ? planned.filter(f => !completed.includes(f))
      : [];
    const batchActive = batchRemaining.length > 0;

    // Only apply post-write rules immediately after writing/editing a file.
    const isWriteTool = lastToolName === 'write_file' || lastToolName === 'edit_file';

    if (isWriteTool) {
      // 3. stopAfterWrite templates (single_file_creation, document_then_wait, etc.):
      //    Complete immediately after the first successful write.
      //    This prevents resumed runs from re-writing the same file.
      const template = state.taskTemplate ? TASK_TEMPLATES[state.taskTemplate] : undefined;
      if (template?.stopAfterWrite && state.artifactsCreated.length > 0) {
        return { action: 'COMPLETE', message: 'File written successfully. Task complete.' };
      }

      // 4. Full batch written → validate then complete
      if (planned.length > 0 && batchRemaining.length === 0) {
        return { action: 'VALIDATE', reason: this.messages.batchComplete };
      }

      // 3. Wait-keyword file detection
      if (lastToolPath) {
        const fileName = lastToolPath.replace(/\\/g, '/').split('/').pop() ?? '';
        const isWaitFile = WAIT_FILENAME_PATTERNS.some(p => p.test(fileName));
        const objectiveWantsWait = WAIT_OBJECTIVE_KEYWORDS.test(state.objective);
        // If a batch is explicitly active, do not wait - generate all files first!
        if ((isWaitFile || objectiveWantsWait) && !batchActive) {
          return { action: 'WAIT', message: this.messages.waitAutoDetected };
        }
      }
    }

    // 4. Default — keep running
    return { action: 'CONTINUE' };
  }
}
