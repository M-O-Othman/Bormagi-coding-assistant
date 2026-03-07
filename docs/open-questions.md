# Open Questions — Context & Token Enhancement (Spec v2)

> Questions for the implementation of `2.ai_coding_assistant_context_token_comprehensive_spec.v2.md`
> **Do not begin implementation until all questions below are answered.**

---

## Section A — Mode Classification (FR-1)

### OQ-1: Mode classification mechanism ✅
The spec requires a lightweight classifier that must NOT use the premium coding model.
Options:
- **A** Rules-based only (keyword/pattern matching on user text — zero cost, deterministic)
- **B** A smaller/cheaper LLM call (e.g., haiku-class model) for ambiguous cases
- **C** User explicitly picks mode from a UI dropdown, with rules-based fallback

**Answer: C** — User explicitly picks mode from a UI dropdown; rules-based classifier is used as auto-detect fallback when no mode is explicitly selected.

### OQ-2: Mode visibility to user ✅
Should the detected mode be shown to the user?
- **A** Hidden/internal only (telemetry only)
- **B** Shown in the VS Code status bar (read-only, informational)
- **C** Shown in status bar AND user can override it before the request is sent

**Answer: C** — Mode shown in status bar; user can override it before sending.

---

## Section B — Repo Map (FR-2)

### OQ-3: Repo map storage location ✅
The spec answers "file-based JSON." Where within the workspace?
- **A** `.bormagi/repo-map.json` (alongside existing `.bormagi/` config)
- **B** VS Code extension global storage (`context.globalStorageUri`)
- **C** VS Code extension workspace storage (`context.storageUri`)

**Answer: A** — Store as `.bormagi/repo-map.json` alongside existing config.

### OQ-4: Repo map refresh strategy ✅
- **A** Rebuild on every session start (simple, always fresh)
- **B** Incremental: watch for file changes, rebuild only changed files (spec preferred)
- **C** Manual: user triggers rebuild via command

**Answer: A** — Rebuild the repo map on every session start.

### OQ-5: Language server integration (spec says mandatory) ✅
The spec mandates LSP for symbol extraction. The codebase is TypeScript-first.
- **A** TypeScript/JavaScript only via VS Code's built-in TS language server (fastest to ship)
- **B** All languages VS Code supports via `vscode.executeDocumentSymbolProvider` (broader coverage, same API)
- **C** Start with (A), document extensibility path to (B)

**Answer: Custom** — Support JavaScript, TypeScript, Java, and Python via `vscode.executeDocumentSymbolProvider`. All four use the same VS Code API; language-specific symbol kinds will be mapped to the spec's `SymbolEntry.kind` enum.

---

## Section C — Instruction Files (FR-4A)

### OQ-6: Instruction file naming convention ✅
The spec shows `.assistant/AGENTS.md` as an example. The project already uses `.bormagi/`.
- **A** Use `.bormagi/instructions/` for all scopes (consistent with existing structure)
- **B** Use the spec's `.assistant/` directory (matches emerging industry standard)
- **C** Support both (`.bormagi/instructions/` and `.assistant/`) and merge them

**Answer: A** — Use `.bormagi/instructions/` for all instruction scopes.

### OQ-7: Directory-scoped instruction files ✅
For path-scoped guidance (e.g., a file in `apps/web/` inherits `apps/web/.assistant.md`):
- **A** Support per-directory instruction files walked from workspace root to active file
- **B** Only repo-root and global scopes for now (simpler)

**Answer: B** — Only repo-root (`.bormagi/instructions/repo.md`) and global (`.bormagi/instructions/global.md`) scopes for now.

---

## Section D — Compaction (FR-9)

### OQ-8: Compaction trigger ✅
- **A** Fully automatic — triggers silently when thresholds are hit (warnAt 65%, compactAt 82%)
- **B** Automatic trigger with a user-visible notification before compacting
- **C** Manual only — user explicitly triggers compaction via command

**Answer: B** — Compaction triggers automatically at threshold, but user sees a notification first.

### OQ-9: Compaction user notification ✅
If compaction is automatic (A or B above), should the user see:
- **A** No notification (silent)
- **B** A brief status bar message ("Context compacted — session summary preserved")
- **C** A notification with a "View Summary" action link

**Answer: C** — Show a VS Code notification with a "View Summary" action that opens the compacted history summary.

---

## Section E — Hooks (FR-15A)

### OQ-10: Hook configuration file location ✅
- **A** `.bormagi/hooks.json` (alongside existing config)
- **B** `.bormagi/config/hooks.json`
- **C** A new top-level `.assistant/hooks.json`

**Answer: B** — Store hook configuration at `.bormagi/config/hooks.json`.

### OQ-11: Hook execution scope ✅
- **A** Hooks run in-process (Node.js function calls, fast, sandboxed to extension)
- **B** Hooks run as shell commands (more flexible, matches spec example, slightly heavier)
- **C** Both: in-process hooks AND shell command hooks as separate types

**Answer: C** — Support both in-process hooks (type: `"internal"`) and shell command hooks (type: `"shell"`) as distinct hook types in `.bormagi/config/hooks.json`.

---

## Section F — Plan Artifacts (FR-15B)

### OQ-12: Plan artifact storage location ✅
- **A** Workspace root as `PLAN.md` + `.bormagi/plans/<id>.json` for machine-readable form
- **B** `.bormagi/plans/` only (no workspace-root markdown)
- **C** User-configurable, defaulting to (A)

**Answer: C** — User-configurable via `bormagi.contextPipeline.plans.storageLocation` and `bormagi.contextPipeline.plans.writePlanMd`, defaulting to `PLAN.md` in workspace root + `.bormagi/plans/<id>.json` for machine-readable state.

### OQ-13: Plan artifact trigger threshold
The spec says create a plan artifact when tasks span multiple files or milestones.
- **A** Always create for any multi-file task (conservative)
- **B** Only when user explicitly enters "plan mode" or uses `/plan` command
- **C** Auto-detect complexity from request text (requires classifier — ties to OQ-1)

---

## Section G — Context Pipeline Integration (FR-5, FR-6, FR-7)

### OQ-14: Backward compatibility / rollout approach
The spec says "old transcript-based path may remain temporarily as a fallback."
- **A** Feature flag: new context pipeline enabled by default, old path as fallback via setting
- **B** Parallel: both run, new pipeline results are logged/compared but old path is used
- **C** Hard cutover: new pipeline replaces old, no fallback

### OQ-15: Retrieval semantic search
The existing `EmbeddingService` + `VectorStore` support knowledge-base documents. Should the new repo map retrieval also use embeddings for semantic search over code?
- **A** Yes — extend the existing embedding/vector infrastructure to index code files
- **B** No — start with lexical search only for the repo map (simpler, faster to ship)
- **C** Lexical now, semantic search as a follow-on phase

### OQ-16: Mode budgets — are the token numbers in the spec final?
The spec defines `MODE_BUDGETS` with specific token counts per slot (e.g., edit mode gets 7000 tokens for `retrievedContext`). These are relative to a specific model context window.
- **A** Use spec values as-is (baseline)
- **B** Make them fully configurable in `package.json` settings and override per workspace
- **C** Use spec values as defaults, allow workspace-level overrides only

---

## Section H — Multi-Model Strategy (Section 16)

### OQ-17: Cheap model for classification/compaction
The spec recommends using a "cheap fast model" for classification, compaction, and summarization. Is this:
- **A** In scope for this implementation (configure a secondary model per workspace)
- **B** Out of scope for now — use the same primary model for all operations
- **C** Out of scope for now — but add the `ModeModelPolicy` interface as a placeholder

---

# Open Questions — Meeting Agent Behavior Improvements

## All Answered ✅

### Q1: @mention interrupts — Real inline interrupts ✅
Extract the question/information request from the requestor's response, then invoke the mentioned agent with that extracted question as context. The mentioned agent responds immediately and control returns to the round-robin.

### Q2: Agent skipping — `[SKIP]` token ✅
Agents respond with `[SKIP]` when they have nothing material to add. Orchestrator hides the skip from the UI and saves tokens.

### Q3: Agenda progression — Human-driven with LLM summary ✅
Each round completes, the moderator LLM summarizes the discussion, then the human decides to continue, override, or mark resolved. Human input can override agent decisions/options.

### Q4: Inline minutes — Append each response + final summary ✅
Append each agent response to minutes as it arrives. Add a full meeting summary + action items section at the end when the meeting concludes.
