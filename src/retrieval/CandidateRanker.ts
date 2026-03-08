// ─── Candidate Ranker ─────────────────────────────────────────────────────────
//
// Scores and prunes `ContextCandidate` items to fit within a token budget slot.
//
// Scoring formula (additive weights, higher = more relevant):
//   - lexical score  (from LexicalSearch)
//   - semantic score (from vector search)
//   - recency bonus  (recently edited files)
//   - active-file bonus
//   - stack-trace / test-failure bonus
//   - production-code bonus (not test/generated)
//
// All weights are configurable via VS Code settings with spec defaults.
//
// Spec reference: §FR-5.

import * as vscode from 'vscode';
import type { AssistantMode, ContextCandidate } from '../context/types';

// ─── Scoring weights ──────────────────────────────────────────────────────────

interface ScoringWeights {
  /** Multiplier applied to the raw lexical match score (normalised 0–1). */
  lexical: number;
  /** Multiplier applied to the vector similarity score (0–1). */
  semantic: number;
  /** Flat bonus for the currently active / open file. */
  activeFile: number;
  /** Flat bonus for files referenced in a stack trace or test failure. */
  diagnosticSignal: number;
  /** Flat bonus for recently edited files. */
  recency: number;
  /** Flat bonus for production (non-test, non-generated) files. */
  productionCode: number;
  /** Flat bonus for the user's directly-imported neighbours (1-hop graph). */
  importNeighbor: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  lexical:          0.40,
  semantic:         0.35,
  activeFile:       0.15,
  diagnosticSignal: 0.30,
  recency:          0.10,
  productionCode:   0.05,
  importNeighbor:   0.10,
};

function getWeights(): ScoringWeights {
  const cfg = vscode.workspace.getConfiguration('bormagi.contextPipeline.ranking');
  return {
    lexical:          safeNum(cfg.get<number>('lexicalWeight',          DEFAULT_WEIGHTS.lexical),          DEFAULT_WEIGHTS.lexical),
    semantic:         safeNum(cfg.get<number>('semanticWeight',         DEFAULT_WEIGHTS.semantic),         DEFAULT_WEIGHTS.semantic),
    activeFile:       safeNum(cfg.get<number>('activeFileBonus',        DEFAULT_WEIGHTS.activeFile),       DEFAULT_WEIGHTS.activeFile),
    diagnosticSignal: safeNum(cfg.get<number>('diagnosticSignalBonus',  DEFAULT_WEIGHTS.diagnosticSignal), DEFAULT_WEIGHTS.diagnosticSignal),
    recency:          safeNum(cfg.get<number>('recencyBonus',           DEFAULT_WEIGHTS.recency),          DEFAULT_WEIGHTS.recency),
    productionCode:   safeNum(cfg.get<number>('productionCodeBonus',    DEFAULT_WEIGHTS.productionCode),   DEFAULT_WEIGHTS.productionCode),
    importNeighbor:   safeNum(cfg.get<number>('importNeighborBonus',    DEFAULT_WEIGHTS.importNeighbor),   DEFAULT_WEIGHTS.importNeighbor),
  };
}

function safeNum(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

// ─── Scoring inputs ───────────────────────────────────────────────────────────

export interface ScoringInput {
  candidate: ContextCandidate;
  /** Normalised lexical score (0–1).  0 when no lexical match. */
  lexicalScore?:   number;
  /** Normalised semantic similarity (0–1).  0 when no vector match. */
  semanticScore?:  number;
  /** True when this file is the currently active editor document. */
  isActiveFile?:   boolean;
  /** True when this file is referenced in a stack trace or failing test. */
  isDiagnosticHit?: boolean;
  /** True when this file appears in the session's recent-edit list. */
  isRecentEdit?:   boolean;
  /** True when this entry is a first-order import neighbour. */
  isImportNeighbor?: boolean;
  /** True when the file is NOT a test/generated/vendored file. */
  isProductionCode?: boolean;
}

// ─── Core score computation ───────────────────────────────────────────────────

/**
 * Compute a composite relevance score for a single `ContextCandidate`.
 *
 * The returned score is on a 0–1 scale (approximate; may slightly exceed 1
 * when multiple bonuses stack).
 */
export function scoreCandidate(input: ScoringInput): number {
  const w = getWeights();
  let score = 0;
  const reasons: string[] = [];

  if (input.lexicalScore && input.lexicalScore > 0) {
    score += w.lexical * input.lexicalScore;
    reasons.push(`lexical:${input.lexicalScore.toFixed(2)}`);
  }
  if (input.semanticScore && input.semanticScore > 0) {
    score += w.semantic * input.semanticScore;
    reasons.push(`semantic:${input.semanticScore.toFixed(2)}`);
  }
  if (input.isActiveFile) {
    score += w.activeFile;
    reasons.push('active-file');
  }
  if (input.isDiagnosticHit) {
    score += w.diagnosticSignal;
    reasons.push('diagnostic-hit');
  }
  if (input.isRecentEdit) {
    score += w.recency;
    reasons.push('recent-edit');
  }
  if (input.isImportNeighbor) {
    score += w.importNeighbor;
    reasons.push('import-neighbor');
  }
  if (input.isProductionCode) {
    score += w.productionCode;
    reasons.push('production-code');
  }

  // Persist reason list back onto the candidate for audit trail.
  if (reasons.length > 0) {
    input.candidate.reasons = [...new Set([...input.candidate.reasons, ...reasons])];
  }

  return score;
}

// ─── Rank and prune ───────────────────────────────────────────────────────────

/**
 * Rank a list of scored candidates and prune to fit within `budgetTokens`.
 *
 * Candidates with `score === 0` are dropped entirely.
 * Within the budget, candidates are sorted score-descending.
 * Once the cumulative `tokenEstimate` would exceed `budgetTokens`, remaining
 * candidates are dropped.
 *
 * @param candidates   Flat array of `ContextCandidate` (with `.score` set).
 * @param budgetTokens Maximum total tokens the returned set may consume.
 * @param mode         Current assistant mode (used to apply mode-specific caps).
 * @returns            Pruned, ranked array.
 */
export function rankAndPrune(
  candidates: ContextCandidate[],
  budgetTokens: number,
  mode: AssistantMode,
): ContextCandidate[] {
  // Drop zero-scored candidates.
  const viable = candidates.filter(c => c.score > 0);

  // Sort descending by score; break ties by path alphabetically.
  viable.sort((a, b) => {
    if (b.score !== a.score) { return b.score - a.score; }
    return (a.path ?? '').localeCompare(b.path ?? '');
  });

  // Cap editable files per mode (spec §FR-10).
  const maxEditable = getMaxEditableFiles(mode);
  let editableCount = 0;

  const result: ContextCandidate[] = [];
  let tokenSum = 0;

  for (const candidate of viable) {
    if (tokenSum + candidate.tokenEstimate > budgetTokens) { break; }

    if (candidate.editable) {
      if (editableCount >= maxEditable) {
        // Demote to reference instead of dropping.
        result.push({ ...candidate, editable: false });
      } else {
        editableCount++;
        result.push(candidate);
      }
    } else {
      result.push(candidate);
    }

    tokenSum += candidate.tokenEstimate;
  }

  return result;
}

// ─── Mode-specific caps ───────────────────────────────────────────────────────

function getMaxEditableFiles(mode: AssistantMode): number {
  const cfg = vscode.workspace.getConfiguration('bormagi.contextPipeline');
  const globalMax = cfg.get<number>('maxEditableFiles', 3);

  // Some modes have tighter editable-file caps.
  const modeCaps: Partial<Record<AssistantMode, number>> = {
    plan:    0, // plan mode outputs plan text, never editable code
    explain: 0,
    search:  0,
    review:  0,
  };

  return modeCaps[mode] ?? globalMax;
}
