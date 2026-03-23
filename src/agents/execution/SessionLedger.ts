/**
 * SessionLedger — records every tool execution in the current session.
 *
 * Bug-fix-008 Fix 5 / Bug-fix-009 Fix 1.7:
 * Provides a ground-truth record of what actually happened so that the
 * final session summary is built from real tool results, not model narration.
 *
 * Only tools that were actually dispatched and returned a status are recorded.
 * Speculative assistant text is never recorded here.
 */

/** Mutation tools — only these can produce "changed files". */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'replace_range',
  'multi_edit',
]);

/** Read tools — tracked for completeness but never counted as "changed". */
const READ_TOOLS = new Set([
  'read_file',
  'read_file_range',
  'read_symbol_block',
  'list_files',
]);

export interface ToolLedgerEntry {
  /** 0-indexed iteration number within this session. */
  turn: number;
  /** Tool name exactly as dispatched. */
  tool: string;
  /** Workspace-relative path the tool operated on, if applicable. */
  path?: string;
  /** Dispatch outcome. */
  status: 'success' | 'error' | 'blocked' | 'cached';
  /** Short human-readable summary (max 200 chars). */
  summary: string;
}

export interface SessionLedger {
  entries: ToolLedgerEntry[];
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createSessionLedger(): SessionLedger {
  return { entries: [] };
}

// ─── Mutation ─────────────────────────────────────────────────────────────────

/**
 * Append an entry to the ledger. Call after each confirmed tool dispatch.
 */
export function recordToolExecution(
  ledger: SessionLedger,
  entry: Omit<ToolLedgerEntry, 'turn'>,
): void {
  ledger.entries.push({
    turn: ledger.entries.length,
    ...entry,
    summary: entry.summary.slice(0, 200),
  });
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the deduplicated list of file paths that were *successfully* written
 * or edited in this session.
 *
 * This is the only authoritative source for "Changed Files" in session reports.
 */
export function collectChangedFiles(ledger: SessionLedger): string[] {
  const seen = new Set<string>();
  for (const entry of ledger.entries) {
    if (
      WRITE_TOOLS.has(entry.tool) &&
      entry.status === 'success' &&
      entry.path
    ) {
      seen.add(entry.path);
    }
  }
  return [...seen];
}

/**
 * Returns the deduplicated list of file paths that were *successfully* read.
 */
export function collectReadFiles(ledger: SessionLedger): string[] {
  const seen = new Set<string>();
  for (const entry of ledger.entries) {
    if (READ_TOOLS.has(entry.tool) && entry.status === 'success' && entry.path) {
      seen.add(entry.path);
    }
  }
  return [...seen];
}

/**
 * Count total tool calls (pure metric, not filtered by status).
 */
export function totalToolCount(ledger: SessionLedger): number {
  return ledger.entries.length;
}

/**
 * Render a deterministic plain-text session report from the ledger.
 *
 * This is the fallback used when degenerate-response recovery fires.
 * The model may only *paraphrase* this payload, not extend it.
 */
export function renderSessionSummary(ledger: SessionLedger): string {
  const changedFiles = collectChangedFiles(ledger);
  const toolCount = totalToolCount(ledger);

  const changedBlock = changedFiles.length
    ? changedFiles.map(f => `- ${f}`).join('\n')
    : '- none';

  return [
    'Session Report',
    '',
    'Changed Files',
    changedBlock,
    '',
    `Tool operations: ${toolCount}`,
  ].join('\n');
}

/**
 * Assert that the caller-supplied summary file list is a subset of the
 * actual ledger writes. Throws with a descriptive message if violated.
 *
 * Bug-fix-008 Fix 8: hard consistency check before surfacing the summary.
 */
export function assertSummaryConsistency(
  ledger: SessionLedger,
  claimedFiles: string[],
): void {
  const actual = new Set(collectChangedFiles(ledger));
  for (const file of claimedFiles) {
    if (!actual.has(file)) {
      throw new Error(
        `Session summary claimed changed file not in ledger: "${file}". ` +
        `Actual writes: [${[...actual].join(', ')}]`,
      );
    }
  }
}
