import type { SessionPhase } from '../ExecutionStateManager';

/**
 * Classified outcome of a single LLM response cycle.
 *
 * Inferred internally from the tool_use stream (PQ-4 Option B).
 * Drives the iteration loop decision: continue | stop | recover.
 *
 * Kinds:
 *   tool     — model called a tool; loop should dispatch and continue
 *   pause    — model produced text only; agent is waiting for user input
 *   complete — run is done; emit completion message and exit
 *   blocked  — validation or recovery error; exit and possibly allow recovery
 */
export type StepContractKind = 'tool' | 'pause' | 'complete' | 'blocked';

export interface StepContract {
  kind: StepContractKind;
  /** kind=tool: the tool that was called */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  reason?: string;
  /** kind=pause: message to show the user */
  pauseMessage?: string;
  /** kind=complete: final summary message */
  completionMessage?: string;
  /** kind=blocked: reason for the block */
  blockedReason?: string;
  /** kind=blocked: true if the agent can attempt recovery */
  recoverable?: boolean;
}

/**
 * Infer a StepContract from the results of a single LLM response cycle.
 *
 * @param toolsUsed   Names of tools called in this iteration.
 * @param assistantText Text output from the model this iteration.
 * @param runPhase    Current terminal/milestone phase of the run.
 */
export function inferStepContract(
  toolsUsed: string[],
  assistantText: string,
  runPhase: SessionPhase,
): StepContract {
  // Any tool call → always a 'tool' contract regardless of text
  if (toolsUsed.length > 0) {
    return {
      kind: 'tool',
      toolName: toolsUsed[0],
      reason: assistantText.slice(0, 200) || undefined,
    };
  }

  // Text-only response — classify by terminal phase signals
  if (runPhase === 'WAITING_FOR_USER_INPUT') {
    return { kind: 'pause', pauseMessage: assistantText };
  }
  if (runPhase === 'COMPLETED') {
    return { kind: 'complete', completionMessage: assistantText };
  }
  if (runPhase === 'BLOCKED_BY_VALIDATION') {
    return { kind: 'blocked', blockedReason: assistantText, recoverable: true };
  }
  if (runPhase === 'RECOVERY_REQUIRED') {
    return { kind: 'blocked', blockedReason: assistantText, recoverable: false };
  }
  if (runPhase === 'PARTIAL_BATCH_COMPLETE') {
    return { kind: 'pause', pauseMessage: assistantText };
  }

  // Default: text-only with RUNNING phase → treat as pause (agent is asking for user input)
  return { kind: 'pause', pauseMessage: assistantText };
}
