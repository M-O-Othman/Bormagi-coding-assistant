/**
 * Discovery budget tracker for the V2 execution engine.
 *
 * Replaces the inline per-counter logic previously embedded in ToolDispatcher._guardState.
 * Each AgentRunner.run() call creates a fresh DiscoveryBudget instance; the dispatcher
 * records every tool call against it.
 *
 * Budget categories:
 *  - wholeFileReads  — read_file calls (expensive, whole-file)
 *  - targetedReads   — read_file_range / read_head / read_tail / read_match_context / read_symbol_block
 *  - globCalls       — glob_files / list_files
 *  - grepCalls       — grep_content / search_files
 *  - consecutiveDiscovery — discovery ops in a row without any write/edit/validate
 */

export interface DiscoveryBudgetConfig {
  maxWholeFileReads: number;      // default 2 (per code mode); was hard-coded as 3 in legacy
  maxTargetedReads: number;       // default 12
  maxGlobCalls: number;           // default 3
  maxGrepCalls: number;           // default 4
  maxConsecutiveDiscovery: number; // default 5 (was 3 in legacy — extended for new tools)
}

export const DEFAULT_BUDGET_CONFIG: DiscoveryBudgetConfig = {
  maxWholeFileReads: 2,
  maxTargetedReads: 12,
  maxGlobCalls: 3,
  maxGrepCalls: 4,
  maxConsecutiveDiscovery: 5,
};

/** Categories for budget tracking. */
export type ToolCategory =
  | 'whole_file'     // read_file
  | 'targeted_read'  // read_file_range, read_head, read_tail, read_match_context, read_symbol_block
  | 'glob'           // glob_files, list_files
  | 'grep'           // grep_content, search_files
  | 'write_or_edit'  // write_file, edit_file, replace_range, multi_edit, replace_symbol_block, insert_*
  | 'validate'       // run_command (resets consecutive counter, not counted against read budgets)
  | 'other';         // git, gcp, virtual tools — not counted

/** Return value from DiscoveryBudget.record(). */
export interface BudgetCheckResult {
  /** Whether the tool call is within budget and should proceed. */
  allowed: boolean;
  /** Human-readable reason shown to the agent when blocked. */
  reason?: string;
  /** Actionable suggestion for the agent when blocked. */
  suggestion?: string;
  /** Which budget category was exhausted. */
  exhaustedCategory?: keyof DiscoveryBudgetConfig;
}

export interface DiscoveryTelemetry {
  wholeFileReads: number;
  targetedReads: number;
  globCalls: number;
  grepCalls: number;
  consecutiveDiscovery: number;
  structuredEdits: number;
  fallbackWrites: number;
}

/**
 * Per-run discovery budget.
 *
 * Usage:
 *   const budget = new DiscoveryBudget();  // at run start
 *   const check = budget.record('whole_file');
 *   if (!check.allowed) { return check.reason; }
 *   // proceed with tool call
 */
export class DiscoveryBudget {
  private readonly config: DiscoveryBudgetConfig;
  private wholeFileReads = 0;
  private targetedReads = 0;
  private globCalls = 0;
  private grepCalls = 0;
  private consecutiveDiscovery = 0;
  private structuredEdits = 0;
  private fallbackWrites = 0;

  constructor(config?: Partial<DiscoveryBudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * Record a tool call and check whether it exceeds the budget.
   * Returns `allowed: false` with a reason and suggestion if the budget is exhausted.
   * Must be called BEFORE executing the tool so the count reflects the attempt.
   */
  record(category: ToolCategory): BudgetCheckResult {
    switch (category) {
      case 'whole_file': {
        if (this.wholeFileReads >= this.config.maxWholeFileReads) {
          return {
            allowed: false,
            exhaustedCategory: 'maxWholeFileReads',
            reason: `[BUDGET] Whole-file read limit reached (${this.config.maxWholeFileReads} reads).`,
            suggestion: 'Use read_file_range, read_head, read_tail, or grep_content for targeted access instead.',
          };
        }
        this.wholeFileReads++;
        this.consecutiveDiscovery++;
        break;
      }
      case 'targeted_read': {
        if (this.targetedReads >= this.config.maxTargetedReads) {
          return {
            allowed: false,
            exhaustedCategory: 'maxTargetedReads',
            reason: `[BUDGET] Targeted read limit reached (${this.config.maxTargetedReads} reads).`,
            suggestion: 'Consolidate reads or proceed to write/edit a file.',
          };
        }
        this.targetedReads++;
        this.consecutiveDiscovery++;
        break;
      }
      case 'glob': {
        if (this.globCalls >= this.config.maxGlobCalls) {
          return {
            allowed: false,
            exhaustedCategory: 'maxGlobCalls',
            reason: `[BUDGET] Glob/list limit reached (${this.config.maxGlobCalls} calls).`,
            suggestion: 'Use grep_content to search within files you already found.',
          };
        }
        this.globCalls++;
        this.consecutiveDiscovery++;
        break;
      }
      case 'grep': {
        if (this.grepCalls >= this.config.maxGrepCalls) {
          return {
            allowed: false,
            exhaustedCategory: 'maxGrepCalls',
            reason: `[BUDGET] Grep limit reached (${this.config.maxGrepCalls} calls).`,
            suggestion: 'Proceed with the matches you already have.',
          };
        }
        this.grepCalls++;
        this.consecutiveDiscovery++;
        break;
      }
      case 'write_or_edit': {
        // Resets consecutive counter; separate tracking for telemetry
        this.structuredEdits++;
        this.consecutiveDiscovery = 0;
        return { allowed: true };
      }
      case 'validate': {
        // run_command also resets consecutive counter
        this.consecutiveDiscovery = 0;
        return { allowed: true };
      }
      case 'other': {
        return { allowed: true };
      }
    }

    // Check consecutive cap after incrementing (applies to all discovery categories)
    if (this.consecutiveDiscovery > this.config.maxConsecutiveDiscovery) {
      return {
        allowed: false,
        exhaustedCategory: 'maxConsecutiveDiscovery',
        reason: `[BUDGET] ${this.config.maxConsecutiveDiscovery} consecutive discovery operations without a write or edit.`,
        suggestion: 'Proceed to write or edit a file — you have done enough discovery.',
      };
    }

    return { allowed: true };
  }

  /**
   * Record a fallback write_file call (separate from structured edits for telemetry).
   */
  recordFallbackWrite(): void {
    this.fallbackWrites++;
    this.consecutiveDiscovery = 0;
  }

  /** Current state snapshot. */
  getState(): DiscoveryTelemetry {
    return {
      wholeFileReads: this.wholeFileReads,
      targetedReads: this.targetedReads,
      globCalls: this.globCalls,
      grepCalls: this.grepCalls,
      consecutiveDiscovery: this.consecutiveDiscovery,
      structuredEdits: this.structuredEdits,
      fallbackWrites: this.fallbackWrites,
    };
  }

  /** Reset all counters (call at run start via resetGuardState). */
  reset(): void {
    this.wholeFileReads = 0;
    this.targetedReads = 0;
    this.globCalls = 0;
    this.grepCalls = 0;
    this.consecutiveDiscovery = 0;
    this.structuredEdits = 0;
    this.fallbackWrites = 0;
  }
}

/**
 * Map a tool name to its budget category.
 * Returns 'other' for tools that do not affect the discovery budget.
 */
export function toolCategory(toolName: string): ToolCategory {
  switch (toolName) {
    case 'read_file':
      return 'whole_file';
    case 'read_file_range':
    case 'read_head':
    case 'read_tail':
    case 'read_match_context':
    case 'read_symbol_block':
      return 'targeted_read';
    case 'glob_files':
    case 'list_files':
    case 'find_symbols':
      return 'glob';
    case 'grep_content':
    case 'search_files':
      return 'grep';
    case 'write_file':
    case 'edit_file':
    case 'replace_range':
    case 'multi_edit':
    case 'replace_symbol_block':
    case 'insert_before_symbol':
    case 'insert_after_symbol':
      return 'write_or_edit';
    case 'run_command':
      return 'validate';
    default:
      return 'other';
  }
}
