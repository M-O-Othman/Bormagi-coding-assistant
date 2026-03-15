/**
 * ObjectiveNormalizer — Prevents accidental objective mutation.
 *
 * Bug-fix004 item 14: The primary objective must remain stable across
 * all resumed sessions. User nudges ("why did you stop", "continue")
 * become `resumeNote`, never the new `primaryObjective`.
 */

/** Patterns that indicate a resume/nudge message, NOT a new task. */
const NUDGE_PATTERNS = [
  /^\s*(why did you stop|why.*stop|you have all|carry on|what.*waiting)/i,
  /^\s*(don'?t stop|keep working|finish|complete the|why.*pause)/i,
  /^\s*(what happened|go ahead.*proceed|just do it|get on with it)/i,
];

const CONTINUE_PATTERNS = [
  /^\s*(continu[ei]|proceed|keep going|go on|go ahead|resume)\s*[.!]?\s*$/i,
];

export type MessageIntent = 'continue' | 'nudge' | 'new_task';

/**
 * Classify a user message as control intent or new task.
 */
export function classifyUserMessage(message: string): MessageIntent {
  if (CONTINUE_PATTERNS.some(p => p.test(message))) { return 'continue'; }
  if (NUDGE_PATTERNS.some(p => p.test(message))) { return 'nudge'; }
  return 'new_task';
}

/**
 * Normalize an objective: trim, collapse whitespace, cap length.
 */
export function normalizeObjective(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Given current state fields and a new user message, return updated
 * primaryObjective / resumeNote without mutating the original objective
 * for nudge/continue messages.
 */
export function reconcileObjective(
  currentPrimaryObjective: string | undefined,
  currentObjective: string,
  userMessage: string,
): { primaryObjective: string; resumeNote?: string; objective: string } {
  const intent = classifyUserMessage(userMessage);

  const primary = currentPrimaryObjective ?? currentObjective;

  if (intent === 'continue' || intent === 'nudge') {
    return {
      primaryObjective: primary,
      resumeNote: intent === 'nudge' ? userMessage.trim() : undefined,
      objective: primary, // preserve original
    };
  }

  // New task — update both
  const normalized = normalizeObjective(userMessage);
  return {
    primaryObjective: normalized,
    resumeNote: undefined,
    objective: normalized,
  };
}
