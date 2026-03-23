/**
 * SynthesisGuard — builds an evidence-gated synthesis payload.
 *
 * Bug-fix-008 Fix 8 / Bug-fix-009 Fix 1.7:
 * Prevents the model from inventing architecture claims or phantom file names
 * when degenerate-response recovery injects a synthesis prompt.
 *
 * Rules enforced:
 *   1. "Changed Files" list comes exclusively from the session ledger.
 *   2. Technology claims are only made when a file proving them was written,
 *      or the requirement text explicitly names the technology.
 *   3. Implemented vs Planned artifacts are always labelled separately.
 */

import type { SessionLedger } from './SessionLedger';
import { collectChangedFiles, collectReadFiles } from './SessionLedger';
import type { ExecutionStateData } from '../ExecutionStateManager';

// ─── Confirmed-technology detection ──────────────────────────────────────────

/**
 * Derive the list of technologies that are directly *proven* by written files
 * or explicitly stated in resolved requirements text.
 *
 * This is intentionally conservative — only obvious signals are used.
 */
export function buildConfirmedTechnologies(
  changedFiles: string[],
  resolvedInputsText: string,
): string[] {
  const tech = new Set<string>();

  // Python back-end signals
  if (
    /fastapi|flask|django|uvicorn/i.test(resolvedInputsText) ||
    changedFiles.some(f => /requirements\.txt$/i.test(f)) ||
    changedFiles.some(f => /\.py$/i.test(f))
  ) {
    tech.add('Python backend');
  }

  // Node / JavaScript back-end signals
  if (
    /express|nestjs|koa|hapi/i.test(resolvedInputsText) ||
    changedFiles.some(f => /package\.json$/i.test(f)) ||
    changedFiles.some(f => /\.(js|ts|mjs|cjs)$/i.test(f))
  ) {
    tech.add('Node.js / JavaScript');
  }

  // React front-end signals
  if (
    /\breact\b/i.test(resolvedInputsText) ||
    changedFiles.some(f => /\.(jsx|tsx)$/i.test(f))
  ) {
    tech.add('React frontend');
  }

  // Docker signals
  if (
    /\bdocker\b/i.test(resolvedInputsText) ||
    changedFiles.some(f => /dockerfile/i.test(f))
  ) {
    tech.add('Docker');
  }

  return [...tech];
}

// ─── Safe synthesis payload ───────────────────────────────────────────────────

export interface SafeSummaryEvidence {
  /** Paths verified to have been written in the ledger. */
  changedFiles: string[];
  /** Paths verified to have been read in the ledger. */
  filesRead: string[];
  /** Technologies confirmed by ledger + resolved input text. */
  confirmedTechnologies: string[];
  /** Artifacts still in the plan but not yet written. */
  plannedButNotImplemented: string[];
  /** The stable primary objective (never mutated by nudge turns). */
  primaryObjective: string;
  /** Path of the last successfully written file, if any. */
  lastActualWritePath: string | null;
  /** Structured stop reason for the session. */
  stopReason: string | null;
}

/**
 * Build the authoritative synthesis evidence payload from the session ledger
 * and execution state.
 *
 * This payload is passed to the model to *paraphrase*, not invent.
 * The model must not claim anything beyond what is in this payload.
 */
export function buildSafeSynthesisPayload(
  state: ExecutionStateData,
  ledger: SessionLedger,
): SafeSummaryEvidence {
  const changedFiles = collectChangedFiles(ledger);
  const filesRead = collectReadFiles(ledger);

  // Collect resolved input text for technology detection
  const resolvedText = Object.values(state.resolvedInputContents ?? {}).join('\n');
  const confirmedTechnologies = buildConfirmedTechnologies(changedFiles, resolvedText);

  // Artifacts in the plan queue that have not yet been written
  const completedPaths = new Set(
    (state.completedArtifacts ?? []).map(a => a.path),
  );
  const remainingPaths = (state.remainingArtifacts ?? [])
    .filter(a => !completedPaths.has(a.path))
    .map(a => a.path);

  const lastActualWritePath =
    (state.completedArtifacts ?? []).at(-1)?.path ?? null;

  return {
    changedFiles,
    filesRead,
    confirmedTechnologies,
    plannedButNotImplemented: remainingPaths,
    primaryObjective: state.primaryObjective ?? state.objective,
    lastActualWritePath,
    stopReason: state.stopReason ?? null,
  };
}

/**
 * Render a plain-text block that may safely be prepended to a synthesis prompt.
 *
 * If the model's generated changed-files list contains phantom entries,
 * this block supersedes it.
 */
export function renderSafeEvidenceBlock(evidence: SafeSummaryEvidence): string {
  const lines: string[] = [
    '=== AUTHORITATIVE SESSION EVIDENCE (do not contradict) ===',
    '',
    `Objective: ${evidence.primaryObjective.slice(0, 200)}`,
    '',
    'IMPLEMENTED (written to disk this session):',
    ...(evidence.changedFiles.length
      ? evidence.changedFiles.map(f => `  - ${f}`)
      : ['  (none)']),
    '',
    'PLANNED (not yet written):',
    ...(evidence.plannedButNotImplemented.length
      ? evidence.plannedButNotImplemented.map(f => `  - ${f}`)
      : ['  (none)']),
    '',
    'Confirmed technologies (ledger-proven):',
    ...(evidence.confirmedTechnologies.length
      ? evidence.confirmedTechnologies.map(t => `  - ${t}`)
      : ['  (none confirmed — do not assume any)']),
    '',
    evidence.stopReason ? `Stop reason: ${evidence.stopReason}` : '',
    '=== END AUTHORITATIVE EVIDENCE ===',
  ].filter(l => l !== undefined) as string[];

  return lines.join('\n');
}
