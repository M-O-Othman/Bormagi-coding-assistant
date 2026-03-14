Additional information that would sharpen the proposal is your exact current Bormagi tool registry and permission model, but there is already enough signal to make a practical upgrade plan.

## Proposition: upgrade Bormagi from “file-at-a-time tools” to a layered code-navigation toolkit

Your current concern is correct: if agents mostly have `read whole file`, `list files`, and generic write/edit, they will over-read, over-narrate, and waste context on exploration. The better coding agents tend to combine **cheap discovery primitives** first, then **targeted reads**, then **structured edits**. Claude Code’s documented skills model and public tool behavior emphasize dedicated tools like `Glob`, `Grep`, `Read`, `Edit`, and hooks/skills rather than raw shell for everything, while OpenAI’s Codex is positioned as an open-source reference implementation for local coding workflows and the surrounding ecosystem is explicitly pushing for first-class `grep`/`glob`, semantic search, and LSP-style intelligence for larger repositories. ([Claude][1])

So the right move is **not** to dump dozens of shell commands into Bormagi. The right move is to build a **small, opinionated tool stack** that gives agents the power of `grep`, `find`, `head`, `tail`, symbol lookup, and selective reads — but through safe, structured tools with consistent outputs, limits, and permissions. Public discussion around both Claude Code and Codex also points to exactly these pain points: dedicated grep/glob equivalents, semantic codebase search, LSP integration, and avoiding brittle overuse of raw shell commands. ([GitHub][2])

## The target operating model

Bormagi agents should follow this default workflow:

1. **Find candidate files cheaply**
   Use filename/path/symbol/content search first.
2. **Read only the relevant slices**
   Read line ranges, heads/tails, function/class blocks, or matched snippets.
3. **Build a change plan**
   Identify exact targets before opening whole files.
4. **Edit with structure-aware tools**
   Prefer block replacement / symbol replacement / multi-edit.
5. **Validate**
   Run compile, tests, lint, import/dependency checks.
6. **Summarize compactly**
   Store findings in execution state, not transcript spam.

That is the biggest practical shift you need.

---

# Recommended new tool categories

## 1. Fast repository discovery tools

These should become first-class tools, not shell fallbacks.

### `glob_files`

Purpose:

* find files by path pattern without reading content

Examples:

* `src/**/*.ts`
* `**/*.{ts,tsx}`
* `**/package.json`

Suggested output:

* relative path
* size
* modified time
* optional classification tag

Why:

* this replaces most bad `list_files` wandering and gives Bormagi the equivalent of `find`/`fd`/`rg --files` in a safe form. Claude Code public tool descriptions and related discussions strongly center dedicated `Glob`/file-pattern tools for this reason. ([kirshatrov.com][3])

### `grep_content`

Purpose:

* regex or literal pattern search across files
* filter by include/exclude glob
* optional case sensitivity

Examples:

* `class\s+ExecutionStateManager`
* `nextAction`
* `write_file\(`
* `TODO|FIXME`

Suggested output:

* file path
* line number(s)
* matching line excerpt
* small context window

Why:

* this is the single highest-value missing primitive in your current model.

### `find_symbols`

Purpose:

* search definitions by symbol name without scanning whole files

Examples:

* class `AgentRunner`
* function `dispatchTool`
* interface `ExecutionTaskState`

Implementation options:

* simple parser/index first
* later backed by LSP or tree-sitter

Why:

* symbol-level navigation cuts context waste drastically.

---

## 2. Targeted read tools

Whole-file reads should become the exception.

### `read_file_range`

Purpose:

* read only line ranges

Examples:

* `AgentRunner.ts`, lines 120–220
* `package.json`, lines 1–80

Suggested output:

* exact line-numbered text
* truncation metadata

### `read_head`

Purpose:

* first N lines of a file

### `read_tail`

Purpose:

* last N lines of a file

### `read_match_context`

Purpose:

* take grep results and expand around them

Example:

* show 25 lines around match at line 482

### `read_symbol_block`

Purpose:

* read one function/class/method block by symbol name

Example:

* read method `prepareMessagesForProvider`
* read class `ToolDispatcher`

Why:

* this gives agents the practical equivalent of `head`, `tail`, grep-context, and IDE “go to definition” without shell hacks.

---

## 3. Structure-aware edit tools

Current `write_file` and `edit_file` are necessary but too primitive alone.

### `replace_range`

Purpose:

* replace a known line range

### `replace_symbol_block`

Purpose:

* replace the body of a function/class/method by symbol name

### `insert_before_symbol`

### `insert_after_symbol`

### `multi_edit`

Purpose:

* apply multiple targeted edits atomically

Why:

* this reduces full-file rewrite churn and is closer to how strong coding agents work with safe editors.

---

## 4. Code intelligence tools

These are the most valuable medium-term upgrades.

### `workspace_index_status`

Purpose:

* know whether a code index exists, is stale, or needs refresh

### `semantic_search`

Purpose:

* search by concept, not exact text

Examples:

* “resume logic for continue”
* “where write/edit redirect happens”
* “state persistence after tool execution”

Why:

* Codex users are explicitly asking for first-class semantic codebase indexing because grep and filename heuristics break down in medium/large repos. ([GitHub][4])

### `lsp_goto_definition`

### `lsp_find_references`

### `lsp_diagnostics`

### `lsp_rename_preview`

Why:

* LSP-backed symbol intelligence is one of the clearest next-step improvements for code agents, and Codex users have explicitly requested built-in LSP support for more precise, project-aware edits. ([GitHub][5])

### `ast_search`

### `ast_rewrite_preview`

Purpose:

* tree-based search and safe refactor preview

Why:

* regex is powerful, but AST tools are much safer for cross-language refactors.

---

## 5. Controlled shell access

Do not remove shell. Constrain it.

### Keep one `bash`/`terminal` tool, but:

* classify it as **last resort** for code navigation
* prefer structured tools for file discovery/search/read/edit
* reserve shell for:

  * build
  * test
  * lint
  * package manager
  * git
  * one-off diagnostics

This matches the public conversation around Claude Code too: people repeatedly run into problems when the agent uses raw bash commands like `cat`, `ls`, `grep`, or `find` instead of dedicated tools, and those dedicated tools are preferred partly because they work better with permissioning and approvals. ([GitHub][6])

---

# Recommended Bormagi skill model changes

Skills should stop being mostly prompt text and become **tool playbooks**.

## A. Add “search-first” skill contracts

Every code agent skill should say:

* do not read whole files until discovery is exhausted
* use `glob_files` before recursive listing
* use `grep_content` before `read_file`
* use `read_match_context` or `read_symbol_block` before whole-file read
* use `multi_edit`/symbol edits where possible
* use shell only for validation/build/test, not routine code navigation

## B. Add repo-scale profiles

Agents need different defaults for:

* **small repo**
* **medium repo**
* **large/monorepo**

Example:

* small repo: more permissive whole-file reads
* medium repo: targeted reads by default
* monorepo: mandatory search-first + read budgets + package-boundary awareness

## C. Add specialist skills

Recommended built-in specialist skills:

* `codebase-navigator`
* `dependency-auditor`
* `refactor-planner`
* `test-locator`
* `api-surface-mapper`
* `resume-recovery-investigator`

Each should expose a preferred tool sequence.

---

# Proposed new Bormagi toolset, in priority order

## Tier 1 — implement immediately

These will give the highest return with low complexity.

1. `glob_files`
2. `grep_content`
3. `read_file_range`
4. `read_head`
5. `read_tail`
6. `read_match_context`
7. `multi_edit`
8. `replace_range`

This tier alone would already fix much of the “reads whole files in one go” problem.

## Tier 2 — implement next

9. `find_symbols`
10. `read_symbol_block`
11. `replace_symbol_block`
12. `insert_before_symbol`
13. `insert_after_symbol`
14. `workspace_index_status`

## Tier 3 — strategic upgrades

15. `semantic_search`
16. `lsp_goto_definition`
17. `lsp_find_references`
18. `lsp_diagnostics`
19. `ast_search`
20. `ast_rewrite_preview`

---

# Concrete design recommendations for each tool

## Output discipline

Every discovery/read tool should return:

* machine-usable JSON
* compact human preview
* truncation metadata
* total-match counts

Do not return large raw blobs by default.

## Input discipline

Every search/read tool should support:

* `path`
* `include`
* `exclude`
* `max_results`
* `max_bytes`
* `timeout_ms`

## Safety discipline

Every edit tool should support:

* preview mode
* dry-run mode
* exact target confirmation
* atomic multi-edit rollback on failure

## Windows/path discipline

Normalize paths centrally. Public Claude Code issue history shows path inconsistency across tools becomes a real reliability problem, especially on Windows/Git Bash. Bormagi should normalize path formats in one place so every tool behaves consistently. ([GitHub][7])

---

# Suggested tool APIs for Bormagi

## `glob_files`

```json
{
  "pattern": "src/**/*.ts",
  "exclude": ["**/node_modules/**", "**/dist/**"],
  "max_results": 200
}
```

## `grep_content`

```json
{
  "pattern": "nextAction|continue",
  "mode": "regex",
  "include": ["**/*.ts"],
  "exclude": ["**/dist/**", "**/node_modules/**"],
  "context_lines": 2,
  "max_results": 100
}
```

## `read_match_context`

```json
{
  "file": "src/agents/AgentRunner.ts",
  "line": 482,
  "before": 20,
  "after": 20
}
```

## `read_symbol_block`

```json
{
  "file": "src/agents/AgentRunner.ts",
  "symbol": "prepareMessagesForProvider",
  "symbol_kind": "function"
}
```

## `multi_edit`

```json
{
  "file": "src/agents/AgentRunner.ts",
  "edits": [
    {"start_line": 120, "end_line": 138, "replacement": "..."},
    {"start_line": 510, "end_line": 522, "replacement": "..."}
  ],
  "require_clean_match": true
}
```

---

# Policy changes to make the tools actually effective

## 1. Change default agent behavior

Default code-agent instruction should become:

* search before read
* read before edit
* targeted read before whole-file read
* whole-file read only when:

  * file is short, or
  * targeted reads are insufficient

## 2. Add budgets

Recommended defaults:

* max whole-file reads per run: 2–3
* unlimited targeted reads within token/tool budget
* max recursive listings: 1
* require `grep_content`/`glob_files` before reading >2 files in same directory tree

## 3. Add automatic escalation rules

If agent tries:

* 4th whole-file read in a run
* repeated `list_files`
* repeated directory wandering

then framework should suggest or force:

* `glob_files`
* `grep_content`
* `find_symbols`

## 4. Add tool telemetry

Track:

* whole-file reads
* range reads
* grep usage
* symbol lookups
* shell navigation commands
* edit success rate

This will tell you if the new tools are actually changing behavior.

---

# Best-practice skill upgrades inspired by Claude Code / Codex patterns

## Add skill packs, not just tools

Claude Code explicitly supports skills as reusable capability bundles, and this is a strong pattern for Bormagi too. ([Claude][1])

Recommended skill packs:

* **Investigate bug**

  * grep → match context → symbol block → diagnostics → edit
* **Implement feature**

  * glob → grep similar code → read symbol blocks → batch plan → multi-edit → test
* **Refactor safely**

  * references → symbol read → AST/LSP preview → multi-edit → tests
* **Dependency cleanup**

  * grep imports → package usage scan → remove dead entries → build/test

## Add mode-specific allowed tools

Public Claude Code discussions also highlight allowlist/read-only distinctions. Bormagi should formalize:

* **ask mode**: glob, grep, read-range, symbol read, diagnostics
* **plan mode**: same as ask + optional semantic search
* **code mode**: all of the above + edit/multi-edit + shell validate
* **review mode**: read-only + diagnostics + grep/glob

([GitHub][8])

---

# “Art of possible” implementation plan

## Phase 1 — high impact, low risk

Implement:

* `glob_files`
* `grep_content`
* `read_file_range`
* `read_head`
* `read_tail`
* `read_match_context`
* `multi_edit`

Then update code-agent prompts/skills to prefer them.

## Phase 2 — structural navigation

Implement:

* `find_symbols`
* `read_symbol_block`
* `replace_symbol_block`

## Phase 3 — intelligence layer

Implement:

* lightweight workspace index
* `semantic_search`
* optional LSP bridge

## Phase 4 — advanced safe refactoring

Implement:

* AST search
* rewrite preview
* rename preview

---

# Recommended final proposition to implementation team

Bormagi should evolve from a **primitive file I/O agent** into a **layered repository-navigation agent** with:

* **first-class discovery tools** (`glob_files`, `grep_content`)
* **targeted read tools** (`read_file_range`, `read_match_context`, `read_symbol_block`)
* **structured edit tools** (`multi_edit`, symbol/block edits)
* **optional intelligence tools** (semantic search, LSP, AST)
* **skill playbooks** that enforce search-first workflows
* **budgets and telemetry** to prevent whole-codebase overreading
* **shell reserved for validation and external commands**, not routine code navigation

That keeps the solution simple enough to implement incrementally, while moving Bormagi much closer to the practical behavior that makes Claude Code/Codex-style agents effective on real repositories. ([GitHub][9])

If you want, the next step should be a **developer-ready backlog** with exact tool names, JSON schemas, permission rules, and rollout order for Bormagi.

[1]: https://code.claude.com/docs/en/skills?utm_source=chatgpt.com "Extend Claude with skills - Claude Code Docs"
[2]: https://github.com/openai/codex/issues/4443?utm_source=chatgpt.com "Are there any future plans to support a basic subset of tools ..."
[3]: https://kirshatrov.com/posts/claude-code-internals?utm_source=chatgpt.com "Reverse engineering Claude Code"
[4]: https://github.com/openai/codex/issues/5181?utm_source=chatgpt.com "Semantic codebase indexing and search · Issue #5181"
[5]: https://github.com/MedChaouch/Puzld.ai?utm_source=chatgpt.com "MedChaouch/Puzld.ai: Multi-LLM orchestration framework"
[6]: https://github.com/anthropics/claude-code/issues/21696?utm_source=chatgpt.com "Claude Code frequently uses Bash cat/ls instead of ..."
[7]: https://github.com/anthropics/claude-code/issues/10289?utm_source=chatgpt.com "[BUG] Read/Edit Tools Don't Support Bash-Style Paths ..."
[8]: https://github.com/anthropics/claude-code/issues/2058?utm_source=chatgpt.com "Separate command allowlists for read-only vs normal ..."
[9]: https://github.com/anthropics/claude-code?utm_source=chatgpt.com "anthropics/claude-code"
