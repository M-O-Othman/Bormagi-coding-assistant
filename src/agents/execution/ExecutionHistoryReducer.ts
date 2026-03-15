import type { ChatMessage } from '../../types';
import type { ExecutionStateData } from '../ExecutionStateManager';

/**
 * Reduces raw session memory into execution-safe compact messages (DD2).
 *
 * For code mode: discards speculative assistant narration and returns only
 * milestone summaries, explicit blocker summaries, and completion summaries.
 * The goal is to prevent stale "I'll start by reading…" narration from
 * polluting future execution runs.
 */

/** Patterns that indicate low-value speculative narration (not milestones). */
const NARRATION_PATTERNS = [
  /^I'll start by\b/i,
  /^Let me (first )?read\b/i,
  /^First, let me\b/i,
  /^I can see from the log\b/i,
  /^I need to first\b/i,
  /^I will now\b/i,
  /^Let me check\b/i,
  /^Let me start by\b/i,
  /^Now let me\b/i,
  /^I'll read\b/i,
  /^Let me examine\b/i,
  /^I'll examine\b/i,
];

/**
 * Build a minimal execution history for code mode.
 *
 * Returns at most:
 * - One system message with the artifact registry note (if provided)
 * - One system message with the compact execution-state note
 * - One assistant milestone line (if available from recent history)
 * - Zero raw previous assistant narration lines
 * - Zero previous user turns
 */
export function buildExecutionHistory(
  execState: ExecutionStateData,
  stateNote: string,
  artifactNote?: string,
): ChatMessage[] {
  const history: ChatMessage[] = [];

  // Artifact registry (if files exist from prior sessions)
  if (artifactNote) {
    history.push({ role: 'system', content: artifactNote });
  }

  // Compact execution state note
  if (stateNote) {
    history.push({ role: 'system', content: stateNote });
  }

  return history;
}

/**
 * Filter a raw session history transcript to remove speculative narration.
 * Preserves only:
 * - Milestone summaries (lines containing "Progress checkpoint", "Milestone", "completed")
 * - Blocker summaries (lines containing "blocked", "error", "failed")
 * - Completion summaries (lines containing "done", "finished", "all files written")
 *
 * Returns the filtered messages (may be empty if everything was narration).
 */
export function reduceTranscript(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(msg => {
    // Keep all non-assistant messages
    if (msg.role !== 'assistant') return true;

    const text = msg.content.trim();
    if (!text) return false;

    // Discard if it matches narration patterns
    const isNarration = NARRATION_PATTERNS.some(p => p.test(text));
    if (isNarration) return false;

    // Keep if it contains milestone/completion/blocker keywords
    const isMilestone = /progress checkpoint|milestone|completed|all.*files.*written|batch complete/i.test(text);
    const isBlocker = /\b(blocked|error|failed|cannot|issue)\b/i.test(text);
    const isSubstantive = text.length > 100 || text.includes('```') || text.includes('{');

    return isMilestone || isBlocker || isSubstantive;
  });
}
