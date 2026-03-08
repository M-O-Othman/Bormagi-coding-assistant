// ─── Budget Engine ─────────────────────────────────────────────────────────────
//
// Pre-flight token budget enforcement.
//
// Responsibilities:
//   1. Compute whether a composed context envelope fits within the model's
//      recommended input budget.
//   2. Produce an ordered list of remediation actions when the budget is
//      exceeded, which the caller applies sequentially until the context fits.
//
// Spec reference: §FR-7, §FR-13.

import type { BudgetCheckResult, ContextCandidate, ContextEnvelope, ModelProfile, ModeBudget } from './types';
import { totalBudget } from '../config/ModeBudgets';

// ─── Budget check ─────────────────────────────────────────────────────────────

/**
 * Determine whether `estimatedInputTokens` fits within the model's recommended
 * input budget.
 *
 * - `hardLimit`  = `profile.recommendedInputBudget`
 * - `softLimit`  = hardLimit minus the `reservedMargin` from `budget`
 *
 * When the estimate exceeds the soft limit the function sets `fits: false` and
 * returns a deterministically ordered remediation action list (spec §FR-13).
 */
export function checkBudget(
  estimatedInputTokens: number,
  budget: ModeBudget,
  profile: ModelProfile,
): BudgetCheckResult {
  const hardLimit = profile.recommendedInputBudget;
  const softLimit = hardLimit - budget.reservedMargin;

  const fits = estimatedInputTokens <= softLimit;
  const overflowBy = fits ? 0 : estimatedInputTokens - softLimit;

  const actions: BudgetCheckResult['actions'] = [];

  if (!fits) {
    // Ordered per spec §FR-13: cheapest/safest first, most drastic last.
    actions.push('prune-reference-snippets');
    actions.push('reduce-repo-map');
    actions.push('summarize-tool-outputs');
    actions.push('reduce-conversation-tail');
    actions.push('degrade-to-plan-only');
  }

  return { fits, estimatedInputTokens, hardLimit, softLimit, overflowBy, actions };
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token (GPT/Claude heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum token estimates across a flat array of candidates. */
function sumCandidates(candidates: ContextCandidate[]): number {
  return candidates.reduce((acc, c) => acc + c.tokenEstimate, 0);
}

/**
 * Estimate total input tokens for a composed context envelope plus fixed
 * budget slots (stablePrefix, memory, userInput, tool overhead).
 */
export function estimateEnvelopeTokens(
  envelope: ContextEnvelope,
  budget: ModeBudget,
  profile: ModelProfile,
): number {
  const envelopeTokens =
    sumCandidates(envelope.editable) +
    sumCandidates(envelope.reference) +
    sumCandidates(envelope.memory) +
    sumCandidates(envelope.toolOutputs);

  return (
    budget.stablePrefix +
    budget.memory +
    budget.userInput +
    profile.estimatedToolOverheadTokens +
    envelopeTokens
  );
}

// ─── Preflight enforcement ────────────────────────────────────────────────────

export interface EnforcementResult {
  envelope: ContextEnvelope;
  budgetCheck: BudgetCheckResult;
  actionsApplied: BudgetCheckResult['actions'];
  degraded: boolean;
}

/**
 * Apply budget enforcement to a context envelope before the LLM call.
 *
 * Actions are applied in spec order until the context fits or the list is
 * exhausted.  The returned `ContextEnvelope` is a new object; the original
 * is not mutated.
 *
 * @param envelope   Fully composed context envelope.
 * @param budget     Mode budget (slot limits) for the current request.
 * @param profile    Active model profile (context window sizes + overhead).
 */
export function enforcePreflightBudget(
  envelope: ContextEnvelope,
  budget: ModeBudget,
  profile: ModelProfile,
): EnforcementResult {
  let current: ContextEnvelope = cloneEnvelope(envelope);
  const actionsApplied: BudgetCheckResult['actions'] = [];
  let degraded = false;

  let check = checkBudget(estimateEnvelopeTokens(current, budget, profile), budget, profile);

  for (const action of check.actions) {
    if (check.fits) { break; }

    switch (action) {
      case 'prune-reference-snippets':
        current = pruneReferenceSnippets(current);
        break;

      case 'reduce-repo-map':
        current = reduceRepoMap(current);
        break;

      case 'summarize-tool-outputs':
        current = summarizeToolOutputs(current);
        break;

      case 'reduce-conversation-tail':
        current = reduceConversationTail(current, budget);
        break;

      case 'degrade-to-plan-only':
        current = degradeToPlanOnly(current);
        degraded = true;
        break;
    }

    actionsApplied.push(action);
    check = checkBudget(estimateEnvelopeTokens(current, budget, profile), budget, profile);
  }

  return { envelope: current, budgetCheck: check, actionsApplied, degraded };
}

// ─── Remediation helpers ──────────────────────────────────────────────────────

/** Drop the lowest-scored reference candidates until we've freed enough room. */
function pruneReferenceSnippets(envelope: ContextEnvelope): ContextEnvelope {
  // Sort ascending by score; drop bottom 30 % (at least one).
  const sorted = [...envelope.reference].sort((a, b) => a.score - b.score);
  const dropCount = Math.max(1, Math.floor(sorted.length * 0.30));
  return {
    ...envelope,
    reference: sorted.slice(dropCount),
  };
}

/** Strip symbol-level detail from repo-map candidates, keeping file paths only. */
function reduceRepoMap(envelope: ContextEnvelope): ContextEnvelope {
  return {
    ...envelope,
    reference: envelope.reference.map(c => {
      if (c.kind !== 'repo-map') { return c; }
      // Truncate content to the first 20 % (file list without symbols).
      const truncated = c.content.slice(0, Math.max(200, Math.ceil(c.content.length * 0.20)));
      return {
        ...c,
        content: truncated,
        tokenEstimate: estimateTokens(truncated),
      };
    }),
  };
}

/** Truncate large tool-output candidates to a brief head + tail excerpt. */
function summarizeToolOutputs(envelope: ContextEnvelope): ContextEnvelope {
  const MAX_TOOL_CHARS = 800;
  return {
    ...envelope,
    toolOutputs: envelope.toolOutputs.map(c => {
      if (c.tokenEstimate <= 200) { return c; }
      const half = Math.floor(MAX_TOOL_CHARS / 2);
      const head = c.content.slice(0, half);
      const tail = c.content.slice(-half);
      const truncated = `${head}\n…[truncated]…\n${tail}`;
      return { ...c, content: truncated, tokenEstimate: estimateTokens(truncated) };
    }),
  };
}

/**
 * Keep only the most recent conversation-tail candidates up to the budget
 * slot limit.  Assumes candidates are ordered oldest-first.
 */
function reduceConversationTail(envelope: ContextEnvelope, budget: ModeBudget): ContextEnvelope {
  const TARGET = budget.conversationTail;
  let remaining = TARGET;
  const kept: ContextCandidate[] = [];

  // Iterate newest-first, accumulate until we hit the target.
  for (const c of [...envelope.editable].reverse()) {
    if (remaining <= 0) { break; }
    kept.unshift(c);
    remaining -= c.tokenEstimate;
  }

  return { ...envelope, editable: kept };
}

/**
 * Last resort: drop all retrieved context except the user's direct input.
 * Signals to downstream that the response will be plan-only, no code edits.
 */
function degradeToPlanOnly(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable: [],
    reference: [],
    memory: envelope.memory,       // keep memory — cheapest preservation
    toolOutputs: [],
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function cloneEnvelope(envelope: ContextEnvelope): ContextEnvelope {
  return {
    editable:    [...envelope.editable],
    reference:   [...envelope.reference],
    memory:      [...envelope.memory],
    toolOutputs: [...envelope.toolOutputs],
  };
}

/**
 * Convenience: given a `ModeBudget`, return the total token allocation across
 * all slots.  Re-exported here for callers that only import from this module.
 */
export { totalBudget };
