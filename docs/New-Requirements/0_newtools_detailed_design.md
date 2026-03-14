Additional information that would sharpen this is your exact current tool registry JSON and approval model, but there is enough to produce a developer-ready backlog now.

# Developer-ready backlog for Bormagi tool and skill upgrade

## 0. Goal

Replace primitive “read whole file / list files / write file” behavior with a layered code-navigation toolkit that is:

* safer
* cheaper in tokens
* easier to govern
* easier to test
* compatible with your current execution engine fixes

This backlog assumes:

* TypeScript codebase
* agent/tool dispatch architecture already exists
* execution state and policy enforcement already exist or are being introduced

---

# 1. Tool architecture principles

1. All new tools must return **structured JSON**, not prose.
2. All read/search tools must support **limits**.
3. All edit tools must support **dry-run/preview** where practical.
4. `.bormagi/**` must remain blocked for direct agent tool access.
5. Shell remains available, but is **not** the default for discovery/navigation.
6. Tool outputs should be compact enough to pass back to the LLM in a structured tool channel.
7. All tool calls should be auditable in execution state.

---

# 2. Exact new tool set

## Tier 1 — implement first

These are the highest-value tools.

### 2.1 `glob_files`

### Purpose

Fast path-based discovery without content reads.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string" },
    "exclude": {
      "type": "array",
      "items": { "type": "string" },
      "default": []
    },
    "max_results": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000,
      "default": 200
    },
    "include_directories": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

### Example input

```json
{
  "pattern": "src/**/*.ts",
  "exclude": ["**/node_modules/**", "**/dist/**"],
  "max_results": 200
}
```

### Example output

```json
{
  "status": "success",
  "matches": [
    {
      "path": "src/agents/AgentRunner.ts",
      "type": "file",
      "size_bytes": 85923,
      "mtime": "2026-03-13T22:10:00.000Z"
    }
  ],
  "truncated": false,
  "total_matches": 1
}
```

### Permission rules

* allowed in ask/plan/code/review
* blocked under `.bormagi/**`
* exclude defaults should always include:

  * `**/node_modules/**`
  * `**/.git/**`
  * `**/dist/**`
  * `**/build/**`

---

### 2.2 `grep_content`

### Purpose

Search file contents by literal or regex.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string" },
    "mode": {
      "type": "string",
      "enum": ["literal", "regex"],
      "default": "literal"
    },
    "include": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["**/*"]
    },
    "exclude": {
      "type": "array",
      "items": { "type": "string" },
      "default": []
    },
    "case_sensitive": {
      "type": "boolean",
      "default": false
    },
    "context_lines": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20,
      "default": 0
    },
    "max_results": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 100
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

### Example input

```json
{
  "pattern": "nextAction|continue",
  "mode": "regex",
  "include": ["src/**/*.ts"],
  "exclude": ["**/dist/**"],
  "context_lines": 2,
  "max_results": 50
}
```

### Example output

```json
{
  "status": "success",
  "matches": [
    {
      "path": "src/agents/AgentRunner.ts",
      "line": 482,
      "column": 15,
      "match_text": "nextAction",
      "line_text": "const nextAction = state.nextAction;",
      "before": ["const state = ..."],
      "after": ["if (!nextAction) {"]
    }
  ],
  "truncated": false,
  "total_matches": 4
}
```

### Permission rules

* allowed in ask/plan/code/review
* blocked under `.bormagi/**`
* must enforce output caps

---

### 2.3 `read_file_range`

### Purpose

Read only a specific line range from a file.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "start_line": { "type": "integer", "minimum": 1 },
    "end_line": { "type": "integer", "minimum": 1 },
    "include_line_numbers": {
      "type": "boolean",
      "default": true
    }
  },
  "required": ["path", "start_line", "end_line"],
  "additionalProperties": false
}
```

### Example output

```json
{
  "status": "success",
  "path": "src/agents/AgentRunner.ts",
  "start_line": 470,
  "end_line": 510,
  "content": [
    { "line": 470, "text": "const state = ..." },
    { "line": 471, "text": "..." }
  ],
  "truncated": false
}
```

### Permission rules

* allowed in ask/plan/code/review
* blocked for `.bormagi/**`
* counts as discovery/read usage

---

### 2.4 `read_head`

### Purpose

Read first N lines of a file.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "lines": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "default": 80
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

---

### 2.5 `read_tail`

### Purpose

Read last N lines of a file.

Same schema as `read_head`.

---

### 2.6 `read_match_context`

### Purpose

Expand around a known file+line match, usually from `grep_content`.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "line": { "type": "integer", "minimum": 1 },
    "before": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100,
      "default": 20
    },
    "after": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100,
      "default": 20
    }
  },
  "required": ["path", "line"],
  "additionalProperties": false
}
```

---

### 2.7 `replace_range`

### Purpose

Targeted line-range replacement.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "start_line": { "type": "integer", "minimum": 1 },
    "end_line": { "type": "integer", "minimum": 1 },
    "replacement": { "type": "string" },
    "create_backup": {
      "type": "boolean",
      "default": false
    },
    "preview_only": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["path", "start_line", "end_line", "replacement"],
  "additionalProperties": false
}
```

### Permission rules

* code mode only
* blocked for `.bormagi/**`
* subject to batch rules where applicable

---

### 2.8 `multi_edit`

### Purpose

Apply multiple edits atomically to one file or multiple files.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "edits": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "start_line": { "type": "integer", "minimum": 1 },
          "end_line": { "type": "integer", "minimum": 1 },
          "replacement": { "type": "string" }
        },
        "required": ["path", "start_line", "end_line", "replacement"],
        "additionalProperties": false
      }
    },
    "preview_only": {
      "type": "boolean",
      "default": false
    },
    "atomic": {
      "type": "boolean",
      "default": true
    }
  },
  "required": ["edits"],
  "additionalProperties": false
}
```

### Behavior

* if `atomic=true`, either all edits apply or none
* produce structured diff summary

---

## Tier 2 — implement next

### 2.9 `find_symbols`

### Purpose

Index-based or parser-based symbol discovery.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "symbol_kind": {
      "type": "string",
      "enum": ["any", "class", "function", "method", "interface", "type", "const"],
      "default": "any"
    },
    "include": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["**/*"]
    },
    "max_results": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 20
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

### Example output

```json
{
  "status": "success",
  "matches": [
    {
      "path": "src/agents/AgentRunner.ts",
      "symbol": "prepareMessagesForProvider",
      "symbol_kind": "method",
      "start_line": 420,
      "end_line": 510
    }
  ]
}
```

---

### 2.10 `read_symbol_block`

### Purpose

Read a whole symbol block by name.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "symbol": { "type": "string" },
    "symbol_kind": {
      "type": "string",
      "enum": ["any", "class", "function", "method", "interface", "type", "const"],
      "default": "any"
    }
  },
  "required": ["path", "symbol"],
  "additionalProperties": false
}
```

---

### 2.11 `replace_symbol_block`

### Purpose

Replace one function/class/method block safely.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "symbol": { "type": "string" },
    "symbol_kind": {
      "type": "string",
      "enum": ["any", "class", "function", "method"],
      "default": "any"
    },
    "replacement": { "type": "string" },
    "preview_only": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["path", "symbol", "replacement"],
  "additionalProperties": false
}
```

---

### 2.12 `insert_before_symbol`

### 2.13 `insert_after_symbol`

### Purpose

Insert code adjacent to a known symbol without rewriting the whole file.

Schema mirrors `replace_symbol_block` but with `content` instead of `replacement`.

---

## Tier 3 — strategic upgrades

### 2.14 `workspace_index_status`

### Purpose

Tell agent whether semantic/symbol index is ready.

### Output example

```json
{
  "status": "success",
  "index_ready": true,
  "index_stale": false,
  "languages": ["typescript", "javascript"],
  "last_built_at": "2026-03-13T23:10:00.000Z"
}
```

---

### 2.15 `semantic_search`

### Purpose

Search by concept, not literal string.

### JSON schema

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "include": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["**/*"]
    },
    "max_results": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

---

### 2.16 `lsp_goto_definition`

### 2.17 `lsp_find_references`

### 2.18 `lsp_diagnostics`

Implement only if you already have enough project/LSP infrastructure.

---

# 3. Permission matrix

## By mode

### Ask mode

Allowed:

* `glob_files`
* `grep_content`
* `read_file_range`
* `read_head`
* `read_tail`
* `read_match_context`
* `find_symbols`
* `read_symbol_block`
* `workspace_index_status`
* `semantic_search`
* `lsp_*` read-only tools
* limited shell for diagnostics only

Blocked:

* `replace_range`
* `multi_edit`
* `replace_symbol_block`
* `insert_before_symbol`
* `insert_after_symbol`
* raw write/edit tools

### Plan mode

Allowed:

* everything from ask mode
* no mutating tools by default

Optional:

* preview-only edit tools if you want planning diffs later

### Code mode

Allowed:

* all search/read tools
* all structured edit tools
* validator/build/test shell commands
* existing `write_file` / `edit_file` as fallback

Blocked:

* `.bormagi/**`
* dangerous shell by default unless explicitly approved

### Review mode

Allowed:

* search/read tools
* diagnostics
* test/lint commands if needed

Blocked:

* mutating tools unless user explicitly asks

---

# 4. Global path and access rules

1. Block direct agent tool access to:

   * `.bormagi/**`
   * `.git/**`
   * `node_modules/**`
   * `dist/**`
   * `build/**`
   * binary files
2. Framework code may read internal files and inject summaries.
3. Normalize all returned paths to repo-relative POSIX-style strings.
4. Preserve original filesystem path internally if needed on Windows.

---

# 5. Discovery and read budget rules

These new tools should work with your existing discovery-budget policy.

## Default budget for code mode

* max whole-file reads: 2
* max targeted reads: 12
* max `glob_files` calls: 3
* max `grep_content` calls: 4
* max consecutive discovery operations without write/edit/validate: 5

## Important distinction

Do **not** count the following as “whole-file reads”:

* `read_file_range`
* `read_head`
* `read_tail`
* `read_match_context`
* `read_symbol_block`

These should be the preferred cheap reads.

---

# 6. Tool result format standard

All tools should return a common envelope.

```ts
export interface BormagiToolResult<T = unknown> {
  status: "success" | "error" | "blocked";
  toolName: string;
  summary: string;
  payload?: T;
  touchedPaths?: string[];
  truncated?: boolean;
  blockedReason?: string;
  redirectedFrom?: string;
}
```

This is important because your execution engine should consume consistent tool results.

---

# 7. Integration points in codebase

## Files/modules to add

### New tool modules

* `src/tools/globFiles.ts`
* `src/tools/grepContent.ts`
* `src/tools/readFileRange.ts`
* `src/tools/readHead.ts`
* `src/tools/readTail.ts`
* `src/tools/readMatchContext.ts`
* `src/tools/replaceRange.ts`
* `src/tools/multiEdit.ts`
* `src/tools/findSymbols.ts`
* `src/tools/readSymbolBlock.ts`
* `src/tools/replaceSymbolBlock.ts`
* `src/tools/insertBeforeSymbol.ts`
* `src/tools/insertAfterSymbol.ts`

### Shared support modules

* `src/tools/common/pathPolicy.ts`
* `src/tools/common/resultEnvelope.ts`
* `src/tools/common/fileFilters.ts`
* `src/tools/common/textSearch.ts`
* `src/tools/common/symbolIndex.ts`
* `src/tools/common/editTransaction.ts`

## Files/modules to modify

* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/AgentRunner.ts`
* `src/agents/PromptComposer.ts`
* tool registry / config files
* permission policy files
* extension command exposure if relevant

---

# 8. Required behavior changes in AgentRunner / execution layer

1. Prefer `glob_files` over recursive `list_files`.
2. Prefer `grep_content` over broad file reads.
3. Prefer targeted read tools over whole-file read.
4. Prefer structured edit tools over full-file rewrite when possible.
5. Log tool usage type in execution state:

   * path discovery
   * content search
   * targeted read
   * whole-file read
   * structured edit
   * fallback write/edit
6. If agent tries too many whole-file reads, return structured guidance:

   * use `grep_content`
   * use `read_match_context`
   * use `find_symbols`

---

# 9. Skill upgrades

## Add or update these skill contracts

### 9.1 `codebase-navigator`

Rules:

1. use `glob_files` first for path discovery
2. use `grep_content` for text discovery
3. use targeted reads before whole-file reads
4. never explore `.bormagi/**`
5. summarize findings compactly

### 9.2 `implement-feature`

Rules:

1. locate similar code with `grep_content`
2. inspect symbol blocks
3. declare batch if greenfield or multi-file structural change
4. use `multi_edit` / symbol edits where possible
5. validate after batch

### 9.3 `bug-investigator`

Rules:

1. grep error strings / suspicious symbols
2. read match context
3. inspect exact symbol block
4. patch narrowly
5. run targeted validation

### 9.4 `dependency-auditor`

Rules:

1. grep imports
2. compare to package manifests
3. identify missing dependencies
4. propose or apply minimal fixes

---

# 10. Rollout order

## Phase 1 — immediate

Implement:

1. `glob_files`
2. `grep_content`
3. `read_file_range`
4. `read_head`
5. `read_tail`
6. `read_match_context`
7. `replace_range`
8. `multi_edit`

Also:

* wire them into `ToolDispatcher`
* update prompts/skills to prefer them
* add tests

## Phase 2 — structural navigation

Implement:
9. `find_symbols`
10. `read_symbol_block`
11. `replace_symbol_block`
12. `insert_before_symbol`
13. `insert_after_symbol`

## Phase 3 — intelligence

Implement:
14. `workspace_index_status`
15. `semantic_search`

## Phase 4 — optional advanced integration

Implement:
16. `lsp_goto_definition`
17. `lsp_find_references`
18. `lsp_diagnostics`

---

# 11. Testing backlog

## Unit tests

1. `glob_files` respects exclude rules
2. `grep_content` returns correct line numbers/context
3. `read_file_range` returns exact slices
4. `read_head` / `read_tail` cap lines correctly
5. `multi_edit` is atomic
6. `replace_symbol_block` only edits intended symbol
7. blocked `.bormagi/**` access returns blocked result
8. path normalization works on Windows-style paths

## Integration tests

1. code mode prefers `grep_content` before broad reads
2. agent can locate and patch a function without reading whole repo
3. agent can edit existing code with `multi_edit`
4. discovery budget is reduced by search/read operations correctly
5. structured tool results integrate with LLM prompt assembly

## Regression tests

1. no whole-codebase wandering when task is local
2. no `.bormagi/**` direct access
3. reduced prompt size compared to old flow
4. fewer whole-file reads per successful task

---

# 12. Telemetry and metrics

Add counters:

* `tool.glob_files.calls`
* `tool.grep_content.calls`
* `tool.read_file_range.calls`
* `tool.read_whole_file.calls`
* `tool.multi_edit.calls`
* `tool.symbol_read.calls`
* `tool.shell_navigation.calls`

Derived metrics:

* average whole-file reads per code task
* average search-first compliance
* prompt token reduction after rollout
* success rate of structured edits vs full-file writes

---

# 13. Backlog items in implementation-ticket format

## Epic 1: Search-first repository navigation

### Ticket 1.1

Implement `glob_files` tool with exclude support, result caps, and path normalization.

### Ticket 1.2

Implement `grep_content` tool with literal/regex modes, context lines, and result caps.

### Ticket 1.3

Add `read_file_range`, `read_head`, `read_tail`, and `read_match_context`.

### Ticket 1.4

Wire new search/read tools into `ToolDispatcher` with permission checks.

### Ticket 1.5

Update code-mode prompt and skills to prefer search-first workflow.

---

## Epic 2: Structured editing

### Ticket 2.1

Implement `replace_range`.

### Ticket 2.2

Implement `multi_edit` with atomic mode and preview mode.

### Ticket 2.3

Add execution-state logging for structured edits.

---

## Epic 3: Symbol-aware navigation

### Ticket 3.1

Implement lightweight `find_symbols`.

### Ticket 3.2

Implement `read_symbol_block`.

### Ticket 3.3

Implement `replace_symbol_block`, `insert_before_symbol`, `insert_after_symbol`.

---

## Epic 4: Intelligence layer

### Ticket 4.1

Implement `workspace_index_status`.

### Ticket 4.2

Design pluggable `semantic_search` interface.

### Ticket 4.3

Prototype LSP bridge for diagnostics/definition/reference lookup.

---

## Epic 5: Policy and governance

### Ticket 5.1

Enforce `.bormagi/**` blocking across all new tools.

### Ticket 5.2

Add search/read budget accounting for new tools.

### Ticket 5.3

Add telemetry counters and debug visibility.

### Ticket 5.4

Add regression tests proving reduced whole-file reading behavior.

---

# 14. Recommended first implementation cut

If you want the most practical first slice without overcomplicating the system, do exactly this first:

1. `glob_files`
2. `grep_content`
3. `read_file_range`
4. `read_match_context`
5. `multi_edit`
6. permission enforcement
7. prompt/skill updates
8. tests + telemetry

That first cut will already materially improve Bormagi’s behavior without requiring LSP, AST, or semantic indexing.

If you want, the next step is to convert this into a **GitHub-issues style work breakdown** with acceptance criteria and estimated implementation complexity for each ticket.
