/**
 * Transient in-run sub-state for observability.
 *
 * Separate from `SessionPhase` (terminal/persistent states in ExecutionStateManager).
 * This type describes what the agent is doing *within* a single run iteration.
 * It is set in memory only — never persisted across restarts.
 *
 * Transitions (V2 path in AgentRunner):
 *   INITIALISING      → set at run start
 *   DISCOVERING       → first read/glob/grep tool dispatched
 *   PLANNING_BATCH    → declare_file_batch tool dispatched
 *   EXECUTING_STEP    → write_file or edit_file tool dispatched
 *   VALIDATING_STEP   → ConsistencyValidator runs after a write
 *   RECOVERING        → RecoveryManager fires
 */
export type ExecutionSubPhase =
  | 'INITIALISING'
  | 'DISCOVERING'
  | 'PLANNING_BATCH'
  | 'EXECUTING_STEP'
  | 'VALIDATING_STEP'
  | 'RECOVERING'
  | 'WRITE_ONLY';

/** Discovery tool names that trigger the DISCOVERING phase. */
export const DISCOVERY_TOOLS = new Set([
  'read_file', 'list_files', 'glob_files', 'grep_content',
  'read_file_range', 'read_head', 'read_tail', 'read_match_context',
  'git_status', 'git_diff', 'git_log', 'get_diagnostics',
]);

/** Mutation tool names that trigger the EXECUTING_STEP phase. */
export const MUTATION_TOOLS = new Set([
  'write_file', 'edit_file',
  'find_and_replace_symbol_block', 'insert_after_symbol_block',
  'run_command',
]);
