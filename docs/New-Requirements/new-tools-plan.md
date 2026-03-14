# Bormagi Layered Code-Navigation Toolkit — Phased Implementation Plan

**Source requirements:** `0_newtools.md`, `0_newtools_detailed_design.md`
**Decision record:** NT-1 through NT-9 in `docs/open-questions.md`
**Date:** 2026-03-14
**Status:** APPROVED FOR EXECUTION

---

## Confirmed Architectural Decisions

| # | Question | Decision |
|---|----------|----------|
| NT-1 | Where do new tools live? | New standalone MCP builtin server `src/tools/code-nav-server.ts`; `filesystem-server.ts` unchanged |
| NT-2 | `search_files` fate | Option C — add `grep_content` as new preferred tool; deprecate `search_files` with a notice in its description |
| NT-3 | Symbol parsing | TypeScript Compiler API for TS/JS/TSX/JSX; regex heuristics as fallback for other file types |
| NT-4 | Discovery budget | Extract to new `src/agents/execution/DiscoveryBudget.ts`; remove inline counters from `ToolDispatcher._guardState` |
| NT-5 | `multi_edit` atomicity | Backup-and-restore: copy target files to `.tmp` before applying; restore all on failure |
| NT-6 | Text externalization | Incremental: only files touched during tool work each phase |
| NT-7 | Phase 6 (V2 flip) | Independent parallel task — not sequenced with this plan |
| NT-8 | Mode enforcement for edit tools | Defense in depth: `filterToolsByMode()` hides + ToolDispatcher rejects (current pattern) |
| NT-9 | Skill playbooks | Injectable fragments in `src/skills/` loaded on demand |

---

## Plan Structure

```
Parallel Track A  ── Phase 6: V2 default flip + V1 removal (independent)
│
Main Track
├── Phase 1  ── Foundation + Tier 1 read/search tools + DiscoveryBudget refactor
├── Phase 2  ── Structured edit tools (replace_range, multi_edit)
├── Phase 3  ── Tier 2 symbol tools (TypeScript Compiler API)
├── Phase 4  ── Skill fragments
└── Phase 5  ── Tier 3 intelligence layer (workspace index, semantic search)

Text externalization applied incrementally to files touched in each phase.
```

---

## Parallel Track A — Phase 6: V2 Default Flip + V1 Removal

**Scope:** Independent of all other phases. Can start immediately.
**Risk:** Low — all V2 regression tests pass.
**Impact:** Removes ~1000 lines of dead V1 code from `AgentRunner.ts`; reduces maintenance burden before new tools land.

### Steps

**A.1 Flip `executionEngineV2` default**

In `package.json` configuration contribution:
```json
"bormagi.executionEngineV2": {
  "type": "boolean",
  "default": true
}
```

**A.2 Run full regression suite**

- `npm test` — all tests must pass with new default.
- Fix any regressions before proceeding.

**A.3 Remove V1 branches from `AgentRunner.ts`**

- Remove every `if (!useV2) { ... }` / `else { ... }` block.
- Remove the `useV2` variable declaration.
- Remove the `bormagi.executionEngineV2` VS Code config read.
- The V2 path becomes the only path.

**A.4 Remove the setting from `package.json`**

- Remove the `bormagi.executionEngineV2` contribution point, or leave as deprecated no-op with a comment.

**A.5 Verify compile + lint clean**

- `npm run compile && npm run lint` must pass with zero errors.

### Acceptance Criteria
- [ ] `executionEngineV2` defaults to `true` in `package.json`
- [ ] All existing tests pass with new default
- [ ] V1 code branches removed from `AgentRunner.ts`
- [ ] Compile and lint clean

---

## Phase 1 — Foundation + Tier 1 Read/Search Tools

**Goal:** Give agents a fast, safe, structured alternative to whole-file reads and raw `list_files`. This is the single highest-return phase.
**Risk:** Low — read/search tools are additive. Nothing is removed until search_files is deprecated (step 1.7, which is soft).
**Must not break:** existing `read_file`, `write_file`, `edit_file`, `list_files` — all stay untouched.

### 1.1 Shared support modules

Create `src/tools/common/` directory with:

**`src/tools/common/pathPolicy.ts`**
- `resolveToolPath(relativePath: string, workspaceRoot: string): string` — resolves + validates path stays within workspace
- `isBlockedPath(resolvedPath: string): boolean` — returns true for `.bormagi/**`, `.git/**`, `node_modules/**`, `dist/**`, `build/**`
- `toRelativePosix(absolutePath: string, workspaceRoot: string): string` — normalises Windows paths to posix-relative for tool outputs
- All existing filesystem/terminal/git servers must continue using their own path validation; this module is for new tools only.
- **Text externalization:** blocked-path error messages go to `data/tool-messages.json` under `"pathPolicy"`.

**`src/tools/common/resultEnvelope.ts`**
- Exports `BormagiToolResult<T>` interface:
  ```typescript
  export interface BormagiToolResult<T = unknown> {
    status: 'success' | 'error' | 'blocked';
    toolName: string;
    summary: string;
    payload?: T;
    touchedPaths?: string[];
    truncated?: boolean;
    blockedReason?: string;
    redirectedFrom?: string;
  }
  ```
- Exports `ok<T>(toolName, summary, payload, extra?)` and `err(toolName, summary, message)` and `blocked(toolName, reason)` factory helpers.

**`src/tools/common/fileFilters.ts`**
- `DEFAULT_EXCLUDES: string[]` — `['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.bormagi/**']`
- `mergeExcludes(userExcludes: string[]): string[]`

**`src/tools/common/textSearch.ts`**
- Wrapper around Node.js `fs` + simple line-by-line regex search (no external deps for Tier 1).
- Used by `grep_content` implementation.

### 1.2 New tool implementations

Create individual tool files in `src/tools/`:

**`src/tools/globFiles.ts`** — implements `glob_files`
- Uses `fast-glob` (already a transitive dep — check `package.json`; add if missing) or `vscode.workspace.findFiles`.
- Input schema: `pattern` (required), `exclude` (array, default empty), `max_results` (1–10000, default 200), `include_directories` (boolean, default false).
- Output: `BormagiToolResult<{ matches: Array<{ path: string, type: 'file'|'dir', size_bytes: number, mtime: string }>, truncated: boolean, total_matches: number }>`.
- Applies `DEFAULT_EXCLUDES` merged with user excludes.
- Normalises all returned paths to posix-relative via `toRelativePosix`.

**`src/tools/grepContent.ts`** — implements `grep_content`
- Input: `pattern` (required), `mode` ('literal'|'regex', default 'literal'), `include` (array, default `['**/*']`), `exclude` (array), `case_sensitive` (boolean, default false), `context_lines` (0–20, default 0), `max_results` (1–1000, default 100).
- Output: `BormagiToolResult<{ matches: Array<{ path, line, column, match_text, line_text, before: string[], after: string[] }>, truncated, total_matches }>`.
- Streams file content line-by-line; stops at `max_results`.
- Blocks `.bormagi/**` via `pathPolicy.isBlockedPath`.

**`src/tools/readFileRange.ts`** — implements `read_file_range`
- Input: `path` (required), `start_line` (required), `end_line` (required), `include_line_numbers` (boolean, default true).
- Output: `BormagiToolResult<{ path, start_line, end_line, content: Array<{ line: number, text: string }>, truncated }>`.
- Counts as a **targeted read** in the discovery budget (not a whole-file read).
- Hard cap: `end_line - start_line` <= 1000 lines; truncate with `truncated: true` if exceeded.

**`src/tools/readHead.ts`** — implements `read_head`
- Input: `path` (required), `lines` (1–500, default 80).
- Output: same envelope as `read_file_range` with line 1 to N.
- Counts as targeted read.

**`src/tools/readTail.ts`** — implements `read_tail`
- Input: `path` (required), `lines` (1–500, default 80).
- Output: same envelope. Counts as targeted read.

**`src/tools/readMatchContext.ts`** — implements `read_match_context`
- Input: `path` (required), `line` (required), `before` (0–100, default 20), `after` (0–100, default 20).
- Reads the specified range, returns `BormagiToolResult` with content array + matched line highlighted.
- Counts as targeted read.

### 1.3 New MCP builtin server

Create **`src/tools/code-nav-server.ts`**:
- Follows the same pattern as `filesystem-server.ts` — exports a list of tool handlers and JSON schemas.
- Registers all Tier 1 tools: `glob_files`, `grep_content`, `read_file_range`, `read_head`, `read_tail`, `read_match_context`.
- Each handler calls its corresponding module from `src/tools/`.
- Server receives `workspaceRoot` on construction (same pattern as existing servers).
- **Text externalization:** All error/blocked messages for the server go to `data/tool-messages.json` under `"codeNav"`.

Wire into the existing MCP host registration (wherever `filesystem-server.ts` is registered — likely `src/tools/MCPHost.ts` or `extension.ts`). The new server is simply appended to the list of builtin servers.

### 1.4 DiscoveryBudget refactor

Create **`src/agents/execution/DiscoveryBudget.ts`**:
```typescript
export interface DiscoveryBudgetConfig {
  maxWholeFileReads: number;    // default 2
  maxTargetedReads: number;     // default 12
  maxGlobCalls: number;         // default 3
  maxGrepCalls: number;         // default 4
  maxConsecutiveDiscovery: number; // default 5 (without a write/edit/validate)
}

export interface DiscoveryBudgetState {
  wholeFileReads: number;
  targetedReads: number;
  globCalls: number;
  grepCalls: number;
  consecutiveDiscovery: number;
}

export class DiscoveryBudget {
  constructor(config?: Partial<DiscoveryBudgetConfig>)
  record(toolCategory: 'whole_file' | 'targeted_read' | 'glob' | 'grep' | 'write_or_edit' | 'validate'): BudgetCheckResult
  getState(): DiscoveryBudgetState
  reset(): void
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;      // only set when allowed=false
  suggestion?: string;  // hint for agent, e.g. "use grep_content instead of read_file"
}
```

- Remove the inline `_guardState` counters from `ToolDispatcher.ts` (the old single `read_file` counter and `list_files` counter).
- Wire `DiscoveryBudget` into `ToolDispatcher.dispatch()` — a `DiscoveryBudget` instance is passed in on construction (per-run).
- Categorise existing tools: `read_file` → `whole_file`; `list_files` → `glob` (counts against glob budget); `write_file`/`edit_file` → `write_or_edit` (resets consecutive counter).
- New tools: `read_file_range`/`read_head`/`read_tail`/`read_match_context`/`read_symbol_block` → `targeted_read`; `glob_files` → `glob`; `grep_content` → `grep`.
- `BudgetCheckResult.suggestion` messages externalized to `data/tool-messages.json` under `"discoveryBudget"`.

### 1.5 Mode-based tool filtering + ToolDispatcher enforcement

**`filterToolsByMode()` update** (wherever this function lives — likely `src/agents/AgentRunner.ts` or `src/context/PromptComposer.ts`):
- Add new read/search tools to the allowed list for all 4 modes (ask/plan/code/review).
- Add new edit tools (`replace_range`, `multi_edit`) to code-mode-only list.
- Symbol edit tools (`replace_symbol_block`, `insert_before_symbol`, `insert_after_symbol`) same — code-mode-only.

**`ToolDispatcher.dispatch()` update**:
- For any edit tool called in a non-code mode: return `blocked(toolName, msgs.editBlockedInMode)` immediately — no execution.
- This is the second layer (defense in depth, per NT-8).
- Blocked message externalized to `data/tool-messages.json`.

### 1.6 Update `data/tools.json`

Add all Tier 1 tool schemas to the `virtualTools` array or `toolServerMap` (depending on registration model). Each tool must document:
- Name, description, inputSchema with required/optional fields and defaults.
- Whether it requires user approval (read/search tools: no; edit tools: yes — but edit tools come in Phase 2).

Add `grep_content` deprecation notice to `search_files` description field:
```json
"description": "Search files by regex. Deprecated: prefer grep_content which returns structured results with context lines, include/exclude globs, and result caps."
```

### 1.7 Update agent system prompts / code.md

In `src/context/prompts/modes/code.md`:
- Add a "Search-first workflow" section instructing agents to:
  1. Use `glob_files` before recursive `list_files` for path discovery.
  2. Use `grep_content` before `read_file` for content discovery.
  3. Use `read_file_range` / `read_match_context` before whole-file reads.
  4. Whole-file reads permitted only when file is short (< 150 lines) or targeted reads are insufficient.
- All instruction strings go in `data/tool-messages.json` under `"searchFirstPolicy"` rather than inline in the markdown — markdown references `{{searchFirstPolicy}}` which the prompt loader substitutes.

In `data/tool-messages.json`, add the new section alongside existing entries.

### 1.8 Tests

New test file: **`src/tests/tools/tier1-tools.test.ts`**

Tests:
1. `glob_files` respects exclude rules — files in `node_modules/` not returned.
2. `glob_files` respects `max_results` cap — truncated flag set when exceeded.
3. `glob_files` blocks `.bormagi/**` paths — returns `blocked` result.
4. `grep_content` returns correct line numbers and match text.
5. `grep_content` respects `context_lines` — correct before/after lines.
6. `grep_content` regex mode — pattern `nextAction|continue` matches both terms.
7. `grep_content` blocks `.bormagi/**`.
8. `read_file_range` returns exact line slice with line numbers.
9. `read_file_range` truncates when range > 1000 lines.
10. `read_head` returns first N lines.
11. `read_tail` returns last N lines.
12. `read_match_context` returns correct surrounding lines.
13. Path normalisation: Windows-style `src\agents\AgentRunner.ts` normalised to `src/agents/AgentRunner.ts` in output.
14. `DiscoveryBudget` — whole-file budget blocks on 3rd call with correct suggestion.
15. `DiscoveryBudget` — targeted reads do not consume whole-file budget.
16. `DiscoveryBudget` — consecutive cap fires after 5 discovery ops without write.
17. `DiscoveryBudget` — write resets consecutive counter.
18. ToolDispatcher blocks edit tool in ask mode with structured `blocked` result.

### Acceptance Criteria — Phase 1
- [ ] All 6 Tier 1 read/search tools registered and callable by agents.
- [ ] `code-nav-server.ts` registered alongside filesystem/git servers.
- [ ] `DiscoveryBudget.ts` replaces inline `_guardState` counters.
- [ ] `filterToolsByMode` + ToolDispatcher both enforce edit-tool blocking in read-only modes.
- [ ] `search_files` shows deprecation notice in description.
- [ ] `code.md` has search-first policy instruction.
- [ ] All 18 new tests pass + full existing regression suite passes.
- [ ] `npm run compile && npm run lint` clean.
- [ ] Text: blocked messages and policy instructions in `data/tool-messages.json`, not inline.

---

## Phase 2 — Structured Edit Tools

**Goal:** Reduce whole-file rewrites. Give agents precise, line-targeted edits and atomic multi-file edits.
**Risk:** Medium — edit tools modify files. Backup-and-restore atomicity (NT-5) mitigates data loss risk.
**Must not break:** existing `write_file` / `edit_file` — they stay unchanged as fallback.

### 2.1 `src/tools/common/editTransaction.ts`

Implements backup-and-restore atomicity for multi_edit:
```typescript
export class EditTransaction {
  constructor(paths: string[])
  async prepare(): Promise<void>   // copy each target file to path + '.bormagi-bak'
  async commit(): Promise<void>    // delete backups on success
  async rollback(): Promise<void>  // restore all backed-up files, delete backups
}
```
- Backup files stored alongside originals as `<filename>.bormagi-bak` (temporary; removed on commit).
- If any write fails, `rollback()` is called — all previously written files are restored.
- **Text externalization:** error messages to `data/tool-messages.json` under `"editTransaction"`.

### 2.2 `src/tools/replaceRange.ts` — implements `replace_range`

- Input: `path` (required), `start_line` (required), `end_line` (required), `replacement` (required string), `create_backup` (boolean, default false), `preview_only` (boolean, default false).
- Validates: `start_line <= end_line`, file exists, not in blocked path.
- `preview_only=true`: returns diff summary without writing — output includes `before_snippet` and `after_snippet`. No file write.
- `preview_only=false`: replaces lines in-place. Returns `BormagiToolResult` with `touchedPaths: [path]` and a diff summary.
- Requires user approval (add to `approvalTools` in `data/tools.json`).
- Counts as `write_or_edit` in DiscoveryBudget.

### 2.3 `src/tools/multiEdit.ts` — implements `multi_edit`

- Input: `edits` (array of `{ path, start_line, end_line, replacement }`, 1–50 items, required), `preview_only` (boolean, default false), `atomic` (boolean, default true).
- `preview_only=true`: apply all edits in-memory, return structured diff summary for all files. No writes.
- `preview_only=false, atomic=true`:
  1. Validate all edits (line ranges valid, paths not blocked).
  2. Group edits by file; sort edits per file by descending `start_line` (so line numbers don't shift as we apply).
  3. Call `EditTransaction.prepare()` to back up all target files.
  4. Apply edits file-by-file. On any failure: call `EditTransaction.rollback()` and return error result with which edit failed.
  5. On success: call `EditTransaction.commit()`.
- `atomic=false`: apply sequentially, report which succeeded and which failed with no rollback (use sparingly — prefer atomic=true).
- Output: `BormagiToolResult<{ applied: number, files_changed: string[], diff_summary: string[], failed?: string }>`.
- Requires user approval.
- Counts as `write_or_edit`.

### 2.4 Register in `code-nav-server.ts` and `data/tools.json`

- Add `replace_range` and `multi_edit` handlers to `code-nav-server.ts`.
- Add to `approvalTools` array in `data/tools.json`.
- Add full JSON schemas to `tools.json`.

### 2.5 Update `code.md`

Add structured-edit policy:
```
Prefer replace_range or multi_edit for targeted changes to existing files.
Use write_file only for new files.
Use edit_file as fallback when line numbers are unknown.
Always use preview_only=true first on large or risky edits.
```
Policy strings go to `data/tool-messages.json` under `"editPolicy"`.

### 2.6 Tests

New test file: **`src/tests/tools/edit-tools.test.ts`**

Tests:
1. `replace_range` — preview_only returns diff, no file write.
2. `replace_range` — applies edit correctly on known fixture file.
3. `replace_range` — blocked in ask mode (ToolDispatcher rejects).
4. `replace_range` — blocked for `.bormagi/**` path.
5. `multi_edit` — preview_only returns diff summary for all edits.
6. `multi_edit` — atomic=true success: all edits applied, backups removed.
7. `multi_edit` — atomic=true failure: one bad edit, all files restored to original state.
8. `multi_edit` — edits applied in descending line order (line-number stability).
9. `multi_edit` — 51-item array rejected with schema validation error.
10. `EditTransaction` rollback — file content matches original after forced rollback.

### Acceptance Criteria — Phase 2
- [ ] `replace_range` and `multi_edit` callable in code mode.
- [ ] `multi_edit` atomic: fixture-level proof that failed edit restores all files.
- [ ] Both blocked in ask/plan/review modes.
- [ ] Both require user approval (in `approvalTools`).
- [ ] All 10 new tests pass + full regression suite passes.
- [ ] Compile and lint clean.

---

## Phase 3 — Tier 2 Symbol Tools (TypeScript Compiler API)

**Goal:** Enable agents to navigate and edit code at the symbol level — without reading whole files.
**Risk:** Medium — TypeScript Compiler API adds ~1–2 MB to bundle. Symbol parsing is complex; incorrect boundary detection could corrupt code. Preview mode mitigates the latter.
**Scope:** TS/JS/TSX/JSX files only. Other file types fall back to regex heuristics (simplified match of `function name`, `class name`, `const name =`).

### 3.1 `src/tools/common/symbolIndex.ts`

Low-level symbol parsing:
```typescript
export interface SymbolLocation {
  symbol: string;
  symbolKind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'const';
  startLine: number;
  endLine: number;
  path: string;
}

export function findSymbols(filePath: string, query: string, kind?: string): SymbolLocation[]
export function readSymbolBlock(filePath: string, symbol: string, kind?: string): { location: SymbolLocation, content: string[] }
export function replaceSymbolBlock(filePath: string, location: SymbolLocation, replacement: string): void
```

Implementation strategy:
- For `.ts`/`.tsx`/`.js`/`.jsx` files: use TypeScript Compiler API (`typescript` package — already required by `ts-node` in dev deps; confirm before adding).
- For other files: regex heuristics — match `function name(`, `class name `, `const name =`, `interface name `, `type name =`.
- The TypeScript Compiler API path:
  - `ts.createSourceFile()` — parse file content (no full program needed, just the source).
  - Walk the AST to find matching `FunctionDeclaration`, `ClassDeclaration`, `MethodDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `VariableStatement`.
  - Use `node.getStart()` and `node.getEnd()` to get exact character positions; convert to line numbers.
- **Text externalization:** error messages to `data/tool-messages.json` under `"symbolTools"`.

### 3.2 New tool implementations

**`src/tools/findSymbols.ts`** — implements `find_symbols`
- Input: `query` (required), `symbol_kind` ('any'|'class'|'function'|'method'|'interface'|'type'|'const', default 'any'), `include` (array), `max_results` (1–200, default 20).
- Globs files matching `include`, parses each for matching symbols.
- Output: `BormagiToolResult<{ matches: SymbolLocation[] }>`.
- Counts as `glob` + `targeted_read` in DiscoveryBudget (one glob call + N targeted reads).

**`src/tools/readSymbolBlock.ts`** — implements `read_symbol_block`
- Input: `path` (required), `symbol` (required), `symbol_kind` (default 'any').
- Output: `BormagiToolResult<{ location: SymbolLocation, content: Array<{ line: number, text: string }> }>`.
- Counts as `targeted_read`.

**`src/tools/replaceSymbolBlock.ts`** — implements `replace_symbol_block`
- Input: `path`, `symbol`, `symbol_kind`, `replacement` (required), `preview_only` (boolean, default false).
- Finds symbol boundary via `symbolIndex.ts`, then calls `EditTransaction` for the specific line range.
- `preview_only=true`: return diff without writing.
- Requires approval.

**`src/tools/insertBeforeSymbol.ts`** and **`src/tools/insertAfterSymbol.ts`**
- Same input structure as `replace_symbol_block` but with `content` instead of `replacement`.
- Insert at `startLine - 1` (before) or `endLine + 1` (after).
- Requires approval.

### 3.3 Register in `code-nav-server.ts` and `data/tools.json`

- Add all 5 symbol tool handlers.
- Add `replace_symbol_block`, `insert_before_symbol`, `insert_after_symbol` to `approvalTools`.
- `find_symbols` and `read_symbol_block` do not require approval.

### 3.4 Update `code.md` / agent prompts

Add symbol-navigation policy:
```
For reading a function or class: prefer read_symbol_block over read_file_range when the symbol name is known.
For editing a function or class: prefer replace_symbol_block over replace_range — it handles boundary detection automatically.
For inserting new code: prefer insert_before_symbol / insert_after_symbol over full-file rewrites.
```

### 3.5 Tests

New test file: **`src/tests/tools/symbol-tools.test.ts`**

Tests using a fixture `.ts` file (`src/tests/fixtures/sample-module.ts`):
1. `find_symbols` — finds all classes in fixture file.
2. `find_symbols` — finds specific function by name.
3. `find_symbols` — `symbol_kind=method` returns only methods.
4. `read_symbol_block` — returns correct lines for a known function.
5. `read_symbol_block` — unknown symbol returns error result.
6. `replace_symbol_block` — preview_only returns diff, no file changed.
7. `replace_symbol_block` — applies replacement, other symbols unchanged.
8. `insert_before_symbol` — inserts content before target symbol.
9. `insert_after_symbol` — inserts content after target symbol.
10. Regex fallback for `.py` file — finds `def my_function(` pattern.
11. `find_symbols` blocked for `.bormagi/**` path.
12. Symbol tools blocked in ask mode.

### Acceptance Criteria — Phase 3
- [ ] All 5 symbol tools callable in code mode.
- [ ] TypeScript Compiler API used for `.ts`/`.tsx`/`.js`/`.jsx`.
- [ ] Regex fallback works for non-TS files.
- [ ] `replace_symbol_block` and `insert_*` require approval.
- [ ] All 12 new tests pass + full regression suite passes.
- [ ] Bundle size increase documented (< 2 MB acceptable per NT-3).
- [ ] Compile and lint clean.

---

## Phase 4 — Skill Fragments

**Goal:** Give agents explicit playbooks that enforce search-first behavior. Skills load on demand rather than bloating every system prompt.
**Risk:** Low — additive only. No existing code modified.

### 4.1 Skill fragment architecture

Create **`src/skills/`** directory. Each skill is a Markdown file injectable into system prompts:

- `src/skills/codebase-navigator.md`
- `src/skills/implement-feature.md`
- `src/skills/bug-investigator.md`
- `src/skills/dependency-auditor.md`

Each fragment follows this structure:
```markdown
## Skill: <name>

### When to activate
<conditions that trigger this skill>

### Required tool sequence
<numbered steps with specific tool names>

### Constraints
<what not to do>
```

### 4.2 Skill content

**`src/skills/codebase-navigator.md`**
```markdown
## Skill: Codebase Navigator

### When to activate
When asked to explore, understand, or map the codebase without making changes.

### Required tool sequence
1. glob_files — discover files matching the topic (e.g. src/**/*.ts)
2. grep_content — find relevant symbols, patterns, or keywords
3. read_match_context or read_symbol_block — read relevant sections only
4. Summarise findings compactly in execution state (update_task_state)
5. Do NOT read whole files unless they are < 100 lines or targeted reads are insufficient

### Constraints
- Never explore .bormagi/**
- Never list_files recursively without a glob pattern first
- Whole-file reads count against the discovery budget (max 2 per run)
```

**`src/skills/implement-feature.md`**
```markdown
## Skill: Implement Feature

### When to activate
When asked to add a new feature, function, or module.

### Required tool sequence
1. glob_files — find related existing files
2. grep_content — find similar patterns in the codebase to match conventions
3. read_symbol_block — read the exact relevant functions/classes
4. declare_file_batch if multiple new files will be created
5. multi_edit or replace_symbol_block for changes to existing files
6. write_file only for genuinely new files
7. run_command to validate (compile, lint, tests)

### Constraints
- Do not write a new file if one already exists (use edit_file or replace_symbol_block)
- Do not rewrite unchanged code blocks
- Declare multi-file batches before writing any files
```

**`src/skills/bug-investigator.md`**
```markdown
## Skill: Bug Investigator

### When to activate
When investigating an error, unexpected behavior, or failing test.

### Required tool sequence
1. grep_content — search for the error string or suspicious symbol
2. read_match_context — expand around the match location
3. read_symbol_block — read the exact failing function/class
4. Identify root cause before patching
5. replace_range or replace_symbol_block for the minimal targeted patch
6. run_command to validate the fix

### Constraints
- Do not patch symptoms — identify root cause first
- Do not rewrite the whole file for a one-line fix
- Add targeted logging if cause is unclear; remove it before finishing
```

**`src/skills/dependency-auditor.md`**
```markdown
## Skill: Dependency Auditor

### When to activate
When asked to audit, clean up, or verify dependencies.

### Required tool sequence
1. grep_content — search for import statements (pattern: ^import|require\()
2. glob_files — locate package manifests (pattern: **/package.json, **/pyproject.toml)
3. read_file_range — read only the dependencies sections of manifests
4. Cross-reference: identify imports not in manifest, or manifest entries not imported
5. Propose minimal removals or additions only

### Constraints
- Do not modify manifests without a clear unused/missing dependency finding
- Do not run npm install without user approval
```

### 4.3 Skill loader

Create **`src/skills/skillLoader.ts`**:
```typescript
export function loadSkillFragment(skillName: string): string | null
// Returns the markdown content of the skill file, or null if not found.
// Reads from src/skills/<skillName>.md at runtime.
```

This is intentionally simple — skills are runtime-readable Markdown files, not compiled-in strings. This satisfies the "external text files readable/modifiable by users" memory requirement.

### 4.4 Integration into prompt assembly

In `PromptAssembler.assembleMessages()` (Phase 1 of the previous plan — already created):
- Accept optional `activeSkills?: string[]` in `PromptContext`.
- If present, load each skill fragment via `skillLoader.loadSkillFragment()` and append as an additional `system` message before the user instruction.
- Skills do not replace the system prompt — they augment it.

In `AgentRunner.ts` V2 path: detect if the user message or task objective contains trigger keywords (e.g. "investigate", "navigate", "audit", "implement") and suggest corresponding skill in `PromptContext.activeSkills`. This is a best-effort suggestion — the skill is only injected if the keyword is found; agents can still use any tool otherwise.

### 4.5 Tests

New test file: **`src/tests/skills/skill-loader.test.ts`**

Tests:
1. `loadSkillFragment('codebase-navigator')` returns non-empty string.
2. `loadSkillFragment('unknown-skill')` returns null.
3. All 4 skill files exist and parse as valid Markdown (headings present).
4. `PromptAssembler` with `activeSkills: ['bug-investigator']` includes skill content in assembled messages.
5. Skill message appears as `role: 'system'` before user instruction.

### Acceptance Criteria — Phase 4
- [ ] All 4 skill fragments exist as readable Markdown files.
- [ ] `skillLoader.ts` loads fragments at runtime (no compile-time embedding).
- [ ] `PromptAssembler` injects active skills as system messages.
- [ ] All 5 new tests pass + full regression suite passes.
- [ ] Compile and lint clean.

---

## Phase 5 — Tier 3 Intelligence Layer

**Goal:** Add workspace-level code indexing and semantic search.
**Risk:** Medium-high — new background process (indexer) + embedding model dependency. LSP bridge is optional.
**Feasibility note:** Phase 5 is a strategic upgrade. Ship Phases 1–4 first; revisit Phase 5 scope based on practical usage patterns observed post-Phase 4 rollout.

### 5.1 `workspace_index_status`

**Simple status tool — implement first, low risk.**

Create **`src/tools/workspaceIndexStatus.ts`**:
- Reads `.bormagi/code-index.json` (if it exists) and returns its metadata.
- Output: `BormagiToolResult<{ index_ready: boolean, index_stale: boolean, languages: string[], last_built_at: string | null, total_files: number }>`.
- `index_stale`: true if `last_built_at` is older than 24 hours or a file newer than the index exists in the workspace.
- Does not build the index — only reads status.
- Allowed in all modes (read-only).

### 5.2 Workspace symbol index (background build)

Create **`src/tools/indexBuilder.ts`**:
- On `code-nav-server.ts` startup, checks if `.bormagi/code-index.json` exists and is fresh.
- If stale or missing: runs an async background index build.
- Index format (`.bormagi/code-index.json`):
  ```json
  {
    "schema_version": "1",
    "last_built_at": "ISO-8601",
    "languages": ["typescript"],
    "symbols": [
      { "path": "src/agents/AgentRunner.ts", "symbol": "AgentRunner", "kind": "class", "start_line": 45, "end_line": 890 }
    ]
  }
  ```
- Build uses `symbolIndex.ts` from Phase 3 — it's already the parsing layer.
- Background build does not block agent tool calls; `workspace_index_status.index_ready` returns false until build completes.
- Index is written to `.bormagi/code-index.json` (the framework writes this; agents cannot directly access `.bormagi/**` but the framework can).

### 5.3 `semantic_search` (text-embedding approach)

**Implement only after 5.1 and 5.2 are stable.**

Strategy: chunk-based local text similarity rather than external embedding API for initial version.
- On index build, generate text embeddings for each symbol block using `@xenova/transformers` (WASM-based, no external API call, bundles well in VS Code extension context).
- Store embeddings in `.bormagi/code-embeddings.bin` (binary float32 array).
- `semantic_search` tool: encode query → cosine similarity against stored embeddings → return top-N symbol blocks.
- Output: `BormagiToolResult<{ matches: Array<{ path, symbol, score, preview }> }>`.
- Fallback: if embeddings not available, fall back to `grep_content` with extracted keywords from query.
- **Flag as optional:** include in plan but implementation is gated on bundle size and performance acceptance testing. If `@xenova/transformers` adds more than 15 MB to bundle, defer to external API option.

### 5.4 LSP integration (optional, lower priority)

The VS Code extension host already has access to LSP via `vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)` and similar built-in commands. This avoids needing a separate LSP bridge.

Implement three thin wrappers:
- `src/tools/lspGotoDefinition.ts` — calls `vscode.executeDefinitionProvider`
- `src/tools/lspFindReferences.ts` — calls `vscode.executeReferenceProvider`
- `src/tools/lspDiagnostics.ts` — calls `vscode.executeDiagnosticProvider` or reads `vscode.languages.getDiagnostics()`

These are low-risk because they delegate to VS Code's existing language servers. Implement only if symbol tools (Phase 3) prove insufficient for real workflows.

### 5.5 Tests

New test file: **`src/tests/tools/tier3-tools.test.ts`**

Tests:
1. `workspace_index_status` — returns `index_ready: false` when no index file exists.
2. `workspace_index_status` — returns `index_stale: true` when index is older than 24h.
3. `workspace_index_status` — returns correct `languages` from index metadata.
4. Index builder — creates `.bormagi/code-index.json` with correct schema.
5. Index builder — symbols from Phase 3 fixture file appear in index.
6. `semantic_search` fallback — when no embeddings, falls back to grep_content behavior.

### Acceptance Criteria — Phase 5
- [ ] `workspace_index_status` callable and returns accurate status.
- [ ] Background index builder runs without blocking agent tool calls.
- [ ] `.bormagi/code-index.json` created with correct schema after index build.
- [ ] `semantic_search` callable (with fallback if embeddings not ready).
- [ ] LSP tools implemented if agent tool gap identified post-Phase 4.
- [ ] All new tests pass + full regression suite passes.
- [ ] Bundle size delta documented.

---

## Cross-Cutting Concerns

### Text Externalization (NT-6: Incremental)

Applied to each phase only for files touched by that phase's work:

| Phase | Files touched | Externalization scope |
|-------|---------------|----------------------|
| 1 | `code-nav-server.ts`, `DiscoveryBudget.ts`, `ToolDispatcher.ts`, `code.md` | Blocked messages, budget exceeded messages, search-first policy text |
| 2 | `editTransaction.ts`, `replaceRange.ts`, `multiEdit.ts` | Edit tool error/preview messages |
| 3 | `symbolIndex.ts`, symbol tool files | Symbol-not-found messages, parse error messages |
| 4 | `skillLoader.ts`, `PromptAssembler.ts` | Skill activation messages |
| 5 | `workspaceIndexStatus.ts`, `indexBuilder.ts` | Index status messages, build progress messages |

All new messages go to **`data/tool-messages.json`** (new sections added per phase):
```json
{
  "pathPolicy": { ... },
  "codeNav": { ... },
  "discoveryBudget": { ... },
  "editPolicy": { ... },
  "editTransaction": { ... },
  "symbolTools": { ... },
  "searchFirstPolicy": { ... },
  "indexStatus": { ... },
  "recovery": { ... }
}
```

The existing `data/execution-messages.json` stays unchanged — `data/tool-messages.json` is a new separate file for tool-layer messages.

### Telemetry

In `DiscoveryBudget.ts`, expose counters for optional telemetry:
```typescript
export interface DiscoveryTelemetry {
  wholeFileReads: number;
  targetedReads: number;
  grepCalls: number;
  globCalls: number;
  structuredEdits: number;   // replace_range + multi_edit + symbol edits
  fallbackWrites: number;    // write_file calls
}
```
These counters are accessible via `DiscoveryBudget.getTelemetry()` and can be logged to the audit log at run end. This directly supports the "prompt token reduction after rollout" and "average whole-file reads per task" metrics from the design doc.

---

## Critical Files Summary

| File | Phase | Action |
|------|-------|--------|
| `src/tools/common/pathPolicy.ts` | 1 | New |
| `src/tools/common/resultEnvelope.ts` | 1 | New |
| `src/tools/common/fileFilters.ts` | 1 | New |
| `src/tools/common/textSearch.ts` | 1 | New |
| `src/tools/common/editTransaction.ts` | 2 | New |
| `src/tools/common/symbolIndex.ts` | 3 | New |
| `src/tools/globFiles.ts` | 1 | New |
| `src/tools/grepContent.ts` | 1 | New |
| `src/tools/readFileRange.ts` | 1 | New |
| `src/tools/readHead.ts` | 1 | New |
| `src/tools/readTail.ts` | 1 | New |
| `src/tools/readMatchContext.ts` | 1 | New |
| `src/tools/replaceRange.ts` | 2 | New |
| `src/tools/multiEdit.ts` | 2 | New |
| `src/tools/findSymbols.ts` | 3 | New |
| `src/tools/readSymbolBlock.ts` | 3 | New |
| `src/tools/replaceSymbolBlock.ts` | 3 | New |
| `src/tools/insertBeforeSymbol.ts` | 3 | New |
| `src/tools/insertAfterSymbol.ts` | 3 | New |
| `src/tools/workspaceIndexStatus.ts` | 5 | New |
| `src/tools/indexBuilder.ts` | 5 | New |
| `src/tools/code-nav-server.ts` | 1 | New |
| `src/skills/codebase-navigator.md` | 4 | New |
| `src/skills/implement-feature.md` | 4 | New |
| `src/skills/bug-investigator.md` | 4 | New |
| `src/skills/dependency-auditor.md` | 4 | New |
| `src/skills/skillLoader.ts` | 4 | New |
| `src/agents/execution/DiscoveryBudget.ts` | 1 | New |
| `src/agents/execution/ToolDispatcher.ts` | 1 | Modify (remove inline counters, wire DiscoveryBudget, add mode enforcement) |
| `src/agents/AgentRunner.ts` | 1, 4 | Modify (mode tool filter update, skill injection) |
| `src/agents/execution/PromptAssembler.ts` | 4 | Modify (activeSkills support) |
| `src/context/prompts/modes/code.md` | 1, 3 | Modify (search-first + symbol-nav policy) |
| `data/tools.json` | 1, 2, 3 | Modify (add tool schemas, deprecation notice, approval list) |
| `data/tool-messages.json` | 1, 2, 3, 4, 5 | New (all tool-layer messages) |
| `package.json` | Track A | Modify (V2 default flip) |

---

## Phase Dependency Graph

```
Track A (independent)
  V2 default flip → V1 removal

Phase 1 (foundation)
  └─ All new tools depend on pathPolicy + resultEnvelope
      ├─ Phase 2 (edit tools) — depends on Phase 1 (DiscoveryBudget, pathPolicy, code-nav-server)
      │     └─ Phase 3 (symbol tools) — depends on Phase 2 (editTransaction for replace/insert)
      │           └─ Phase 4 (skill fragments) — depends on Phase 3 (skill references symbol tools)
      │                 └─ Phase 5 (intelligence) — depends on Phase 3 (symbolIndex for indexBuilder)
      └─ Track A can start in parallel with Phase 1
```

Phases 2 and 3 are sequential (symbol edit tools need editTransaction from Phase 2).
Track A is fully independent of all phases.

---

## New Test Files Summary

| File | Phase | Test count |
|------|-------|-----------|
| `src/tests/tools/tier1-tools.test.ts` | 1 | 18 |
| `src/tests/tools/edit-tools.test.ts` | 2 | 10 |
| `src/tests/tools/symbol-tools.test.ts` | 3 | 12 |
| `src/tests/skills/skill-loader.test.ts` | 4 | 5 |
| `src/tests/tools/tier3-tools.test.ts` | 5 | 6 |

Target: +51 new tests across 5 phases, all passing alongside full existing regression suite.
