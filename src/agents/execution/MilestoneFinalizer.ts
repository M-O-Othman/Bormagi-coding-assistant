import type { ExecutionStateData } from '../ExecutionStateManager';
import type { StepContract } from './StepContract';
import { TASK_TEMPLATES } from './TaskTemplate';

/**
 * Deterministic per-step decision after a tool execution.
 *
 * Priority order (highest first):
 *   1. pause/complete/blocked from StepContract or terminal SessionPhase
 *   2. full batch written → VALIDATE then COMPLETE
 *   3. write to a wait-keyword file + objective contains "wait"/"document" → WAIT
 *   4. consecutive write checkpoint → VALIDATE
 *   5. default → CONTINUE
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
   * @param stepContract     Classified outcome of the LLM response cycle.
   * @param lastToolName     Name of the tool just executed.
   * @param lastToolPath     Path argument of the tool (for write/edit tools).
   * @param objectiveKeywords Pre-split words from the objective (lower-case).
   */
  decide(
    state: ExecutionStateData,
    stepContract: StepContract,
    lastToolName: string,
    lastToolPath?: string,
  ): MilestoneDecision {
    // 1. Terminal phase signals from state override everything
    if (state.runPhase === 'RECOVERY_REQUIRED') {
      return { action: 'BLOCK', reason: 'Recovery required', recoverable: false };
    }
    if (state.runPhase === 'WAITING_FOR_USER_INPUT') {
      return { action: 'WAIT', message: state.waitStateReason ?? this.messages.waitAutoDetected };
    }
    if (state.runPhase === 'COMPLETED') {
      return { action: 'COMPLETE', message: stepContract.completionMessage ?? 'Task completed.' };
    }
    if (state.runPhase === 'BLOCKED_BY_VALIDATION') {
      return { action: 'BLOCK', reason: stepContract.blockedReason ?? 'Validation failed', recoverable: true };
    }

    // 2. Batch heartbeat invariant (item 4, bug-fix004):
    //    Active batch + remaining files + no hard blocker = MUST CONTINUE.
    //    This overrides StepContract 'pause' signals — the LLM's narration/pause
    //    must NOT end a session with an active batch.
    const planned = state.plannedFileBatch ?? [];
    const completed = state.completedBatchFiles ?? [];
    const batchRemaining = planned.length > 0
      ? planned.filter(f => !completed.includes(f))
      : [];
    const batchActive = batchRemaining.length > 0;

    // 2a. StepContract terminal signals — but batch override 'pause'
    if (stepContract.kind === 'complete') {
      // If batch still has remaining files, override 'complete' to CONTINUE
      if (batchActive) { return { action: 'CONTINUE' }; }
      return { action: 'COMPLETE', message: stepContract.completionMessage ?? 'Task completed.' };
    }
    if (stepContract.kind === 'blocked') {
      return { action: 'BLOCK', reason: stepContract.blockedReason ?? 'Blocked', recoverable: stepContract.recoverable ?? true };
    }
    if (stepContract.kind === 'pause') {
      // Batch heartbeat: active batch overrides pause — force continuation
      if (batchActive) { return { action: 'CONTINUE' }; }
      return { action: 'WAIT', message: stepContract.pauseMessage ?? this.messages.waitAutoDetected };
    }

    // For 'tool' contract kind, check post-write rules
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

      // 5. Wait-keyword file detection
      if (lastToolPath) {
        const fileName = lastToolPath.replace(/\\/g, '/').split('/').pop() ?? '';
        const isWaitFile = WAIT_FILENAME_PATTERNS.some(p => p.test(fileName));
        const objectiveWantsWait = WAIT_OBJECTIVE_KEYWORDS.test(state.objective);
        if (isWaitFile || objectiveWantsWait) {
          return { action: 'WAIT', message: this.messages.waitAutoDetected };
        }
      }
    }

    // 5. Default — keep running
    return { action: 'CONTINUE' };
  }
}
