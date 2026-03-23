/**
 * TurnIntentClassifier — classifies the user's per-turn intent.
 *
 * Bug-fix-008 Fix 4 / Bug-fix-009 Fix 1.6:
 * Separates the short-lived turn intent from the long-lived task objective.
 *
 * - 'continue_task'        → resume planned execution deterministically
 * - 'diagnostic_question'  → answer without mutating files
 * - 'status_question'      → report current state without mutating files
 * - 'modify_scope'         → update plan then re-classify
 * - 'new_task'             → treat as a fresh task
 */

export type TurnIntent =
  | 'continue_task'
  | 'diagnostic_question'
  | 'status_question'
  | 'modify_scope'
  | 'new_task';

/** Patterns that map unambiguously to 'continue_task'. */
const CONTINUE_PATTERNS: RegExp[] = [
  /^\s*(continu[ei]|proceed|keep going|go on|go ahead|resume)\s*[.!]?\s*$/i,
  /^\s*(go|carry on|keep writing|keep implementing|finish it|complete it)\s*[.!]?\s*$/i,
];

/** Patterns that map to diagnostic intent — no mutation allowed. */
const DIAGNOSTIC_PATTERNS: RegExp[] = [
  /why\s+did\s+you\s+(stop|pause|halt)/i,
  /what\s+(happened|went\s+wrong|made\s+you\s+stop)/i,
  /why\s+(did\s+it|are\s+you|have\s+you)\s+(stop|pause|halt)/i,
  /\bwhat\s+do\s+you\s+want\s+from\s+me\b/i,
  /\bwhy\s+are\s+you\s+waiting\b/i,
];

/** Patterns that map to status/progress query — no mutation allowed. */
const STATUS_PATTERNS: RegExp[] = [
  /\b(status|progress|what\s+have\s+you\s+done|how\s+far|how\s+much)\b/i,
  /\bwhat\s+(files?|artifacts?)\s+(have\s+you|did\s+you)\s+(written?|created?|made?)\b/i,
  /\bwhat\s+is\s+(left|remaining|next\s+on\s+the\s+list)\b/i,
];

/** Patterns that map to scope modification. */
const MODIFY_SCOPE_PATTERNS: RegExp[] = [
  /\b(instead|change|use\s+\w+\s+instead|separate|split)\b/i,
  /\b(don'?t\s+use|switch\s+to|replace\s+with)\b/i,
];

/**
 * Classify a single user turn into a TurnIntent.
 *
 * This is intentionally lightweight (no LLM call).
 * The result is used to decide whether to:
 *   - resume implementation (continue_task)
 *   - answer diagnostically without mutation (diagnostic_question / status_question)
 *   - update scope then re-plan (modify_scope)
 *   - start a new task (new_task)
 */
export function classifyTurnIntent(text: string): TurnIntent {
  const trimmed = text.trim();

  if (CONTINUE_PATTERNS.some(p => p.test(trimmed))) {
    return 'continue_task';
  }

  if (DIAGNOSTIC_PATTERNS.some(p => p.test(trimmed))) {
    return 'diagnostic_question';
  }

  if (STATUS_PATTERNS.some(p => p.test(trimmed))) {
    return 'status_question';
  }

  if (MODIFY_SCOPE_PATTERNS.some(p => p.test(trimmed))) {
    return 'modify_scope';
  }

  return 'new_task';
}

/**
 * Returns true if the intent demands a non-mutating response.
 * Used by AgentRunner to skip file writes for diagnostic/status turns.
 */
export function isNonMutatingIntent(intent: TurnIntent): boolean {
  return intent === 'diagnostic_question' || intent === 'status_question';
}

/**
 * Returns true if the intent requests deterministic task continuation.
 */
export function isContinuationIntent(intent: TurnIntent): boolean {
  return intent === 'continue_task';
}
