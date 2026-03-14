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

### OQ-13: Plan artifact trigger threshold ✅
The spec says create a plan artifact when tasks span multiple files or milestones.
- **A** Always create for any multi-file task (conservative)
- **B** Only when user explicitly enters "plan mode" or uses `/plan` command
- **C** Auto-detect complexity from request text (requires classifier — ties to OQ-1)

**Answer: A** — Always create a plan artifact for any multi-file task. Each plan is a new timestamped file (e.g., `.bormagi/plans/plan-<timestamp>.json` and `PLAN-<timestamp>.md`). Existing plan files are never overwritten.

---

## Section G — Context Pipeline Integration (FR-5, FR-6, FR-7)

### OQ-14: Backward compatibility / rollout approach ✅
The spec says "old transcript-based path may remain temporarily as a fallback."
- **A** Feature flag: new context pipeline enabled by default, old path as fallback via setting
- **B** Parallel: both run, new pipeline results are logged/compared but old path is used
- **C** Hard cutover: new pipeline replaces old, no fallback

**Answer: C** — Hard cutover. The new context pipeline fully replaces the old transcript-based path with no fallback.

### OQ-15: Retrieval semantic search ✅
The existing `EmbeddingService` + `VectorStore` support knowledge-base documents. Should the new repo map retrieval also use embeddings for semantic search over code?
- **A** Yes — extend the existing embedding/vector infrastructure to index code files
- **B** No — start with lexical search only for the repo map (simpler, faster to ship)
- **C** Lexical now, semantic search as a follow-on phase

**Answer: A** — Extend the existing `EmbeddingService` + `VectorStore` to also index code files from the repo map, enabling semantic search alongside lexical search in the `RetrievalOrchestrator`.

### OQ-16: Mode budgets — are the token numbers in the spec final? ✅
The spec defines `MODE_BUDGETS` with specific token counts per slot (e.g., edit mode gets 7000 tokens for `retrievedContext`). These are relative to a specific model context window.
- **A** Use spec values as-is (baseline)
- **B** Make them fully configurable in `package.json` settings and override per workspace
- **C** Use spec values as defaults, allow workspace-level overrides only

**Answer: B** — Fully configurable. Spec values are the defaults.
- Values live in `src/config/ModeBudgets.ts` as exported constants (single source of truth in code).
- All budget slots are also exposed as `package.json` `contributes.configuration` settings so users can override them in VS Code settings or `.vscode/settings.json`.
- Onboarding documentation covering all budget settings must be added to `README.md`.

---

## Section H — Multi-Model Strategy (Section 16)

### OQ-17: Cheap model for classification/compaction ✅
The spec recommends using a "cheap fast model" for classification, compaction, and summarization. Is this:
- **A** In scope for this implementation (configure a secondary model per workspace)
- **B** Out of scope for now — use the same primary model for all operations
- **C** Out of scope for now — but add the `ModeModelPolicy` interface as a placeholder

**Answer: Custom** — A dedicated pre-defined system agent (`__bormagi_context_agent__`) is registered in the agent registry for context pipeline tasks (mode classification, history compaction, summarization). Rules:
- The agent is **fully configurable by the user** — provider, model, and system prompt can all be edited via the normal agent settings UI.
- The agent is **undeletable** — the delete action is hidden/disabled for this agent in the UI; the registry enforces its presence at startup and recreates it with defaults if somehow missing.
- If no override is configured, it **defaults to the global agent provider config**, exactly like all other agents.
- The `ModeModelPolicy` interface is added as a typed wrapper so the pipeline can reference the resolved provider cleanly.

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

---

# Open Questions — Execution Layer Fixes & Enhancements

> Questions for the implementation of fixes from `0logissues.md` and `0high_priority fixes.md`
> **Do not begin implementation until all questions below are answered.**

---

## EQ-1: Missing content in `0Logfixes.md`

The file `docs/New-Requirements/0Logfixes.md` appears to be empty (only 1 line). Was there supposed to be content there (a separate list of proposed fixes), or is the content in `0high_priority fixes.md` the definitive merged fix plan?

**Answer:**
File updated
---

## EQ-2: Feature flags vs. hard cutover

The `0high_priority fixes.md` recommends 5 feature flags (`executionStateV2`, `toolResultIsolation`, `silentExecution`, `batchPlanner`, `validatorEnforcement`). Given the previous decision on context pipeline was "hard cutover, no fallback" (OQ-14), should the execution layer fixes also be:

- **A** Feature-flagged — old behaviour preserved behind flags, new behaviour opt-in (safer rollout, more code)
- **B** Hard cutover — replace old behaviour directly, no flags (simpler, less code, but riskier)
- **C** Feature-flagged initially, flags removed after regression tests pass (best of both)

**Answer:**
Option C
1. Choose **Option C** for execution-layer rollout.
2. Implement the new execution path behind a **single top-level feature flag**: `executionEngineV2`.
3. Put under `executionEngineV2` all core fixes together:

   * authoritative `ExecutionStateManager`
   * tool-result isolation from user chat
   * `nextAction`-based continue/resume
   * silent-execution enforcement
   * reread blocking
   * batch enforcement
   * automatic validator invocation
4. Keep the old execution behavior temporarily available only while `executionEngineV2` is being tested.
5. Do **not** create many small feature flags for each sub-behavior unless absolutely necessary.
6. Add a second flag only if required: `validatorEnforcement`.
7. Use `validatorEnforcement` only if validator strictness may block rollout while repo drift is being cleaned up.
8. Enable `executionEngineV2` in targeted regression testing first.
9. Run regression tests covering:

   * no tool results in user chat
   * continue resumes from `nextAction`
   * reread guard works
   * silent execution suppresses narration
   * batch rules are enforced
   * validator catches obvious scaffold inconsistencies
10. Run real-session validation on:

* greenfield workspace flow
* continue/resume flow
* existing-project flow

11. If tests and real-session validation pass, make `executionEngineV2` the default path.
12. Keep the old path only for a short stabilization period.
13. Remove the old execution path after regression tests and live validation pass.
14. Remove the temporary feature flag(s) after cutover is proven stable.
15. Keep the final architecture simple: one authoritative execution path, no permanent dual-mode behavior.

---

## EQ-3: Tool result injection — current state assessment

The log analysis says "tool results are still flowing through the conversational stream." My codebase analysis shows `AgentRunner.ts` is 82KB with complex message flow. The tool results appear to be passed back to the LLM as part of the conversation history for multi-turn tool use.

Clarification needed: Should tool results be:

- **A** Completely removed from conversation history (the LLM never sees tool output text — only a structured summary is injected as a system note)
- **B** Kept in conversation but in a structured format (not as "user" role messages — using a dedicated "tool" role or system injection)
- **C** Kept as-is for multi-turn tool use (LLM needs to see tool output to decide next action) but stripped from **persisted** state/transcript for resume

**Answer:**
1. Choose **Option B** for tool-result handling.
2. Keep tool results visible to the LLM during the live run.
3. Stop sending tool results as `user` role messages.
4. Introduce a dedicated **tool-result channel** in the execution pipeline.
5. Use native provider `tool` role where supported.
6. Where native tool role is unavailable, inject tool results as a dedicated structured system/tool block.
7. Keep raw tool outputs out of ordinary conversation history.
8. Persist only compact tool execution summaries in execution state.
9. Do not let raw tool-result text pollute resume transcript or persisted state.
10. Update `AgentRunner` so multi-turn tool use consumes structured tool results instead of fake chat messages.
11. Preserve enough tool-result detail for the LLM to decide the next action during the same live run.
12. Keep resume context compact by storing summaries and metadata rather than replaying raw tool outputs.

Ready for the next question.

---

## EQ-4: Scope of "silent execution mode"

The requirement says when the user says "do not narrate", set `silentExecution=true`. This suppresses assistant text before tool calls.

- **A** Silent mode applies only to the current run/turn — resets on next user message
- **B** Silent mode persists in execution state until the user explicitly turns it off
- **C** Silent mode is a per-agent setting (some agents always run silent in code mode)
- **D** Code mode is always silent by default; ask/plan modes are always verbose

**Answer:**
1. Choose **Option A** for `silentExecution`.
2. Apply silent mode only to the **current run/turn** when the user explicitly says things like “do not narrate” or “execute immediately”.
3. Reset `silentExecution` automatically on the next user message unless the user explicitly asks for silent behavior again.
4. Do **not** persist silent mode in long-lived execution state as a default behavior.
5. Do **not** make silent mode a per-agent permanent setting.
6. Do **not** make all code mode runs silent by default.
7. Keep code mode normally concise, but only enforce hard no-narration when the user explicitly requests it in that run.
8. Store `silentExecution=true` only as a short-lived run-context flag, not as a durable preference.
9. Allow resume/continue within the same run to keep silent mode active until that run completes.
10. On the next separate user request, fall back to normal code-mode behavior unless the user again requests silent execution.

Ready for the next question.

---

## EQ-5: Batch planning — mandatory or optional?

The `0high_priority fixes.md` requires "greenfield code mode must declare batch before first write." This adds overhead for simple tasks (e.g., "add a logging statement to this file").

- **A** Batch planning is mandatory for all code-mode tasks (strict, as described)
- **B** Batch planning is mandatory only for greenfield/multi-file tasks; single-file edits skip it
- **C** Batch planning is always optional but recommended — the agent can write freely, batch just provides structure
- **D** Batch planning is mandatory for greenfield, optional for existing-project edits

**Answer:**
1. Choose **Option D** for batch planning.
2. Make batch planning **mandatory for greenfield code-mode tasks**.
3. Make batch planning **optional for existing-project edits**.
4. Treat a workspace as greenfield when there is no real project scaffold or when the task is clearly creating a new implementation structure.
5. Require a declared file batch before the first write in greenfield code mode.
6. Keep the first greenfield batch small and coherent, such as 3–5 files.
7. For existing-project edits, allow direct single-file or small-scope edits without mandatory batch declaration.
8. Permit the agent to skip batch planning for simple existing-file changes such as adding a log statement, fixing a bug in one file, or updating a small function.
9. Still allow optional batch planning for existing-project work when the task is multi-file, high-risk, or structurally significant.
10. Add a simple task classifier to decide whether the task is:

    * greenfield scaffold
    * existing-project single-file edit
    * existing-project multi-file change
11. Enforce batch rules automatically only for the greenfield scaffold path.
12. For existing-project edits, keep batch planning available as a tool for structure, not as mandatory overhead.
13. Persist declared batches in execution state only when a batch is actually created.
14. Use validator checkpoints automatically after each mandatory greenfield batch.
15. Avoid universal mandatory batching, because it would add unnecessary friction to small maintenance edits.


---

## EQ-6: Architecture lock — scope and override

The proposal includes an "architecture lock" that prevents the agent from switching frameworks mid-task. Questions:

- Should the architecture lock be derived automatically from existing project files (e.g., detect NestJS from `package.json`), or should the user explicitly set it?
- Can the user override/change the lock mid-session if needed?
- Does this apply only to greenfield projects, or also when modifying existing codebases?

**Answer:**
1. Derive the architecture lock **automatically by default** from the existing project when modifying an existing codebase.
2. Detect the architecture lock from concrete signals such as:

   * `package.json` dependencies and scripts
   * framework-specific config files
   * existing folder structure
   * existing entrypoints and imports
3. For greenfield tasks, derive an initial architecture lock from:

   * the plan/design documents
   * workspace classification
   * the first scaffold decision made by the execution layer
4. Do **not** require the user to explicitly set the architecture lock in normal cases.
5. Allow the user to **explicitly override** the architecture lock when needed.
6. Treat a user override as an intentional change request, not as a normal automatic adjustment.
7. If the user overrides the lock mid-session, update the execution state and invalidate any incompatible pending batch.
8. When a mid-session override happens, require the execution layer to:

   * clear or amend the current planned batch
   * re-run architecture-sensitive validation
   * set a new `nextAction`
9. Do **not** allow the model to silently change the architecture lock on its own mid-task.
10. Allow automatic lock updates only when the current lock is unset and strong project evidence is discovered.
11. Apply architecture lock to **both**:

* greenfield projects
* existing codebase modifications

12. In existing codebases, make the architecture lock **stricter** because preserving current conventions is more important than in greenfield work.
13. In greenfield work, allow the architecture lock to be established after initial discovery and before the first scaffold batch.
14. In existing projects, establish the architecture lock before any structural write.
15. Store the architecture lock in execution state as part of the authoritative task state.
16. Include in the lock at minimum:

* backend framework
* ORM/data layer
* repo shape/structure
* frontend framework if relevant

17. Use the architecture lock during validation to detect drift, such as framework imports or file structures inconsistent with the locked architecture.
18. If project evidence is ambiguous, prefer existing codebase conventions over plan/general templates.
19. If no reliable evidence exists in an existing project, fall back to a compact inferred lock with low-confidence status and allow validation warnings instead of hard blocking.
20. Keep the solution simple: automatic by default, user-overridable, enforced in both greenfield and existing-project contexts, with stronger enforcement for existing codebases.


---

## EQ-7: Discovery budget — hard numbers

The requirement says discovery budget should be "blocking, not advisory." What specific limits do you want?

- Maximum `read_file` calls per run: ___
- Maximum `list_files` calls per run: ___
- Maximum consecutive discovery calls without a write: ___
- Should these be configurable per-agent or global?

**Answer:**
1. Set the **maximum `read_file` calls per run to 3** by default.
2. Set the **maximum `list_files` calls per run to 2** by default.
3. Set the **maximum consecutive discovery calls without a write to 3**.
4. Apply these limits as **hard blocking limits**, not advisory hints.
5. Use these limits primarily for **code mode** runs.
6. Count as discovery calls:

   * `read_file`
   * `list_files`
   * similar workspace-inspection tools
7. Do **not** count writes, edits, validation, or test execution as discovery calls.
8. Reset the consecutive discovery counter immediately after a successful `write_file` or `edit_file`.
9. If the read/list budget is exhausted, block further discovery calls for that run unless:

   * a validation failure explicitly requires rereading a changed file
   * the framework enters a controlled recovery path
10. Make the limits **global defaults**, not per-agent by default.
11. Allow optional per-agent overrides only later if a real need emerges.
12. Keep the first implementation simple: one shared set of discovery-budget defaults for all agents in code mode.
13. Recommended default budget profile:

* `read_file`: 3
* `list_files`: 2
* consecutive discovery without write: 3

14. For greenfield tasks, require the agent to move from discovery to architecture lock or batch declaration once the discovery budget is reached.
15. For existing-project edits, allow the same default limits initially; do not complicate the first rollout with different per-task numeric budgets.
16. Persist budget usage in execution state for the current run.
17. If a blocked discovery call is attempted, return a structured error telling the execution layer to:

* declare a batch
* perform a write/edit
* run validation
* or enter recovery mode

18. Add regression tests to verify that discovery calls are blocked after these limits are reached.


---

## EQ-8: `.bormagi` access filtering

The requirement says block agent access to `.bormagi/**` during normal task execution. However, some agents legitimately need to read `.bormagi/` files (e.g., reading Memory.md, exec-state files, workflow state).

- **A** Block all `.bormagi/` access from the agent's tool calls; framework code reads what it needs and injects into context
- **B** Block `.bormagi/` by default but allow specific patterns (e.g., `Memory.md`, `instructions/`)
- **C** Block only during code mode; allow in ask/plan modes

**Answer:**
1. Choose **Option A** for `.bormagi/` access filtering.
2. Block **all direct `.bormagi/**` access** from normal agent tool calls.
3. Treat `.bormagi/` as **framework/internal control data**, not normal project workspace content.
4. Do **not** let the model decide which `.bormagi/` files to read directly.
5. Move all legitimate `.bormagi/` reads into **framework code**, not agent-exposed tool execution.
6. Have the framework read required `.bormagi/` data such as:

   * memory/context files
   * execution state
   * workflow state
   * internal instructions
7. Inject only the **minimum required structured summary** from `.bormagi/` into the agent context.
8. Do **not** expose raw `.bormagi/` file contents to the agent unless there is a very specific framework-controlled reason.
9. Apply the block in **all modes**: ask, plan, and code.
10. Keep the mode behavior simple and consistent; do not create special `.bormagi/` access rules per mode.
11. Implement the deny rule in the authoritative tool-dispatch layer, not only in prompt text.
12. Return a structured blocked-access result if an agent tries to read `.bormagi/**`.
13. Add explicit framework-owned helper functions for safe internal reads of `.bormagi/` content.
14. Ensure resume state, memory, workflow metadata, and internal instructions are passed through controlled summaries instead of direct file access.
15. Add regression tests to verify that agent tool calls cannot directly access `.bormagi/**`.
16. Add regression tests to verify that framework code can still read needed `.bormagi/` data and inject the correct summaries.
17. Keep the first implementation strict and simple: full direct block for agents, framework-mediated access only.


---

## EQ-9: ConsistencyValidator — failure action

When the validator detects issues (e.g., missing dependency in `package.json`, broken import), what should happen?

- **A** Hard block — refuse to continue until issues are fixed (agent must auto-fix)
- **B** Warn the user — show issues but allow continuation
- **C** Auto-fix what can be fixed, warn on what can't, block on critical issues only
- **D** Log and surface in UI — never block the agent

**Answer:**
1. Choose **Option C** for `ConsistencyValidator` failure handling.
2. Automatically fix issues that are clearly safe and mechanically resolvable.
3. Examples of safe auto-fixes include:

   * adding a missing dependency that is directly required by newly written code
   * fixing a script entrypoint path when the intended generated file clearly exists
   * updating a declared batch file status after a successful write if state drift is purely bookkeeping
4. Warn the user about issues that cannot be safely auto-fixed.
5. Treat as **critical issues** anything that would make the generated scaffold or edit clearly invalid or unsafe to continue.
6. Examples of critical issues include:

   * unresolved imports with no clear dependency choice
   * architecture-lock violations
   * missing required entrypoint with no obvious correct target
   * writes outside the declared mandatory batch
   * incompatible framework/ORM mismatch
7. Block further execution on critical issues until they are fixed.
8. Allow execution to continue after non-critical issues if:

   * safe auto-fixes were applied, and
   * remaining issues are warnings only
9. Persist validator results in execution state with severity levels:

   * `info`
   * `warning`
   * `critical`
10. Record for each validator issue:

* file
* rule
* severity
* auto-fixed or not
* blocking or not

11. Surface validator results in the UI and final run summary.
12. When auto-fixes are applied, include them in the final summary so the user can see what was changed.
13. Do not silently ignore validator failures.
14. Do not hard-block on every validator issue, because that would create too much friction.
15. Do not make validator purely informational, because that would fail to prevent broken scaffolds and drift.
16. Add a simple decision rule:

* auto-fix safe issues
* warn on non-critical unresolved issues
* block on critical issues

17. Run the validator after each mandatory greenfield batch and after meaningful multi-file existing-project changes.
18. Add regression tests to verify:

* safe issues are auto-fixed
* warnings are surfaced without blocking
* critical issues stop further execution

19. Keep the first implementation simple with a small set of well-defined critical rules.
20. Expand the auto-fix set only after the initial validator flow is stable.


---

## EQ-10: Transcript sanitisation — retroactive or forward-only?

Should the transcript sanitisation (stripping `[write_file: ...]`, `TOOL:...`, XML wrappers, fake bootstrap text):

- **A** Apply retroactively to existing conversation history in memory
- **B** Apply only to new messages going forward
- **C** Apply on every prompt assembly (clean the transcript each time before sending to LLM)

**Answer:**
1. Choose **Option C** for transcript sanitisation.
2. Apply transcript sanitisation **on every prompt assembly** before sending context to the LLM.
3. Clean both:

   * newly generated messages
   * any retained prior conversation history included in the next prompt
4. Strip protocol-like noise each time, including:

   * `[write_file: ...]`
   * `TOOL:...`
   * XML tool wrappers
   * fake bootstrap/acknowledgment text
   * internal control markers
5. Do **not** rely on forward-only sanitisation, because old polluted transcript entries may still be replayed into future prompts.
6. Do **not** mutate or rewrite raw historical storage immediately unless you explicitly choose to do a separate cleanup migration later.
7. Keep the first implementation simple: sanitize the prompt input view, not the stored raw conversation log.
8. Treat sanitisation as a **prompt-assembly step**, not a one-time historical rewrite.
9. Ensure sanitisation runs before every LLM call in all modes: ask, plan, and code.
10. Preserve legitimate user and assistant content while removing only tool/protocol/control noise.
11. Keep structured execution state separate from transcript sanitisation; do not depend on transcript cleanup to fix state corruption.
12. Add regression tests to verify that polluted historical transcript content is removed from the assembled prompt even if it still exists in stored history.
13. Add regression tests to verify that new protocol-like noise is stripped before prompt send.
14. Consider optional retroactive storage cleanup later as a maintenance task, but do not make it part of the first implementation.
15. Use sanitisation on every prompt assembly as the default long-term behavior.


---

## EQ-11: Continue/resume semantics — user UX

When the user types "continue", the plan says to resume from `nextAction`. Should the chat UI:

- **A** Show a brief summary of what's being resumed before executing ("Resuming: writing src/index.ts from batch 1...")
- **B** Just silently resume and start executing
- **C** Show the execution state and ask for confirmation before resuming

**Answer:**
1. Choose **Option A** for continue/resume UX.
2. When the user types `continue`, resume from `nextAction` automatically.
3. Before executing, show a **brief one-line summary** of what is being resumed.
4. Keep the resume summary short and operational, for example:

   * `Resuming: write src/index.ts from batch 1`
   * `Resuming: run validation for current batch`
   * `Resuming: continue Phase 1 scaffold from next planned file`
5. Do **not** silently resume with no visible indication.
6. Do **not** ask for confirmation before every resume.
7. Avoid turning `continue` into an extra approval step unless the next action is unusually risky.
8. Keep the normal continue flow fast:

   * show brief summary
   * execute immediately
9. If `silentExecution=true` is active for the current run, still allow a **minimal resume summary** unless the user explicitly requested zero narration.
10. If the user explicitly requested absolute silence, skip the resume summary and execute immediately.
11. If `nextAction` is missing or invalid, show a short recovery message instead of guessing, for example:

* `Cannot resume: next action is missing; rebuilding execution state`

12. If the resumed action is blocked by validator or policy, show a short status explaining the block.
13. Keep the continue UX consistent across ask, plan, and code modes, but it matters most in code mode.
14. Persist enough state so the UI can generate the resume summary without rereading transcript history.
15. Add regression tests to verify:

* `continue` resumes from `nextAction`
* a brief resume summary is shown by default
* confirmation is not requested in normal resume flow
* explicit silent mode can suppress even the brief resume summary

Ready for the next question.

---

## EQ-12: Extension debug commands — visibility

The plan proposes `bormagi.showExecutionState` and `bormagi.resetExecutionState` commands. Should these be:

- **A** Always visible in the command palette (all users can access)
- **B** Hidden behind a "developer mode" setting
- **C** Available as slash commands in chat (`/exec-state`, `/reset-state`)

**Answer:**
1. Choose **Option B** for execution-state debug commands.
2. Put `bormagi.showExecutionState` behind a **developer mode** setting.
3. Put `bormagi.resetExecutionState` behind the same **developer mode** setting.
4. Keep these commands out of the normal default user surface.
5. Do **not** make them always visible to all users by default.
6. Do **not** make chat slash commands the primary first implementation.
7. Add a simple setting such as `bormagi.developerMode: true|false`.
8. Register the commands only when developer mode is enabled, or make them discoverable only in that mode.
9. Keep the commands available through the **command palette**, not only through internal tooling.
10. Treat `showExecutionState` as low-risk debug visibility for developers and testers.
11. Treat `resetExecutionState` as a higher-risk recovery command and keep it developer-only.
12. Add a confirmation step for `resetExecutionState` before destructive reset is performed.
13. Allow `showExecutionState` to display compact task state, not raw internal files.
14. Ensure `resetExecutionState` resets execution state only, not workspace/project files.
15. Add telemetry or audit logging when either debug command is used.
16. Keep slash-command support as a possible later enhancement, not part of the first rollout.
17. Add regression tests to verify the commands are hidden when developer mode is off.
18. Add regression tests to verify the commands are available when developer mode is on.
19. Add regression tests to verify reset affects execution state only and does not delete user code.
20. Keep the first implementation simple: developer-mode-gated command palette commands only.


---

## EQ-13: Dependency audit scope

The plan includes a "dependency and runtime alignment" phase. The current `package.json` has many dependencies. Should we:

- **A** Do a full audit — verify every import resolves, remove dead deps, add missing ones
- **B** Minimal audit — only ensure the new execution layer files compile and their deps exist
- **C** Full audit + add verification scripts (`verify:imports`, `verify:execution`, `verify:state`) to CI

**Answer:**
1. Choose **Option B** for the first implementation phase.
2. Perform a **minimal dependency audit** focused on the new execution-layer changes only.
3. Verify that all files touched by the execution-layer rollout compile and their dependencies exist.
4. Scope the first audit to files such as:

   * `AgentRunner`
   * `ExecutionStateManager`
   * `ToolDispatcher`
   * `PromptComposer`
   * `ConsistencyValidator`
   * any new batch/architecture-lock helpers
5. Add any missing dependencies required by these modified execution-layer files.
6. Do **not** start by removing dead dependencies across the whole repo.
7. Do **not** block the execution-layer rollout on a full repository-wide dependency cleanup.
8. Keep the first audit focused on avoiding breakage in the hot execution path.
9. Run compile/lint/test checks against the modified execution-layer scope before widening the audit.
10. Defer full dead-dependency cleanup until after the execution-layer fixes are stable.
11. Defer broad repo-wide import verification until after regression tests for the new execution path pass.
12. Add lightweight verification only where needed to support the rollout, not a full CI policy change yet.
13. Treat full audit and CI hardening as a later follow-up phase once the new execution path is working reliably.
14. Keep the solution simple and practical: stabilize the execution layer first, then expand dependency hygiene later.
15. Record any broader dependency drift discovered during the minimal audit as backlog items rather than expanding scope immediately.


---

## EQ-14: Text externalisation priority

The codebase is ~95% externalised already. The remaining inline text is in:
1. `AgentSettingsPanel.ts` — ~600 lines of inline HTML/CSS/JS with UI labels
2. `ChatController.ts` — mode labels, help text (~10 lines)
3. `ModePromptLoader.ts` — fallback mode contracts (~3 short strings)
4. `AgentManager.ts` — default agent prompt template (~4 lines)
5. `chat.html` — ~15 hardcoded UI strings (placeholders, tooltips, empty states)

Should text externalisation be:

- **A** Done as part of each phase (externalise strings in files being modified)
- **B** Done as a dedicated phase after execution fixes are stable
- **C** Only externalise `AgentSettingsPanel.ts` (the biggest offender) — the rest is fine as fallbacks

**Answer:**
1. Choose **Option A** for text externalisation priority.
2. Externalise text **incrementally as part of each phase** when the file is already being modified.
3. Do **not** create a separate dedicated externalisation phase before the execution fixes are complete.
4. Do **not** expand the first rollout into a broad repo-wide text cleanup task.
5. Prioritise externalisation in files that are touched by the current implementation work.
6. Treat `AgentSettingsPanel.ts` as the **highest-priority externalisation target** when that file is modified, because it is the largest remaining inline-text area.
7. Externalise `ChatController.ts` strings when modifying that file for execution/resume UX changes.
8. Externalise `ModePromptLoader.ts` fallback strings when modifying that file, but keep simple fallback behavior intact.
9. Externalise `AgentManager.ts` default prompt-template text when modifying that file, but avoid changing prompt behavior unnecessarily.
10. Externalise `chat.html` strings when modifying chat UI behavior, placeholders, tooltips, or empty states.
11. Keep small fallback strings acceptable temporarily if the file is not otherwise being changed in the current phase.
12. Avoid opening files solely for minor text externalisation during the execution-fix rollout unless the file is already part of the active patch set.
13. Preserve existing functionality while externalising: no UX wording changes unless required.
14. Use the current externalisation pattern already used elsewhere in the codebase; do not introduce a second text-loading mechanism.
15. Add a simple rule for the implementation team: **if you touch a file during this rollout, externalise its remaining inline user-facing strings before closing the change**.
16. Track remaining non-externalised strings as backlog items, but do not block execution-layer fixes on them.
17. Keep the solution practical: opportunistic cleanup during active edits, not a standalone cleanup campaign.
18. Reassess after execution fixes stabilize whether any remaining inline text still justifies a focused cleanup pass.


---

# Open Questions — Execution Layer Fixes v2 (00high priority fixes2.md + Log Analysis)
> Questions for the new 25-item implementation plan from `docs/New-Requirements/00high priority fixes2.md`.
> Log analysis (`tmp/.bormagi/logs/advanced-coder.log`) confirms all bugs are real and occurring in production sessions.
> **Do not begin planning until all questions below are answered.**

---

## EQ-15: Prompt assembly redesign — approach and scope

Item 3 says "stop replaying full system prompt + resume blocks + old conversation fragments on every LLM call."

The log confirms: every call (#1–#9) replays the full 5,444-char system prompt, the execution state block, the workspace status block, and the entire prior conversation including all tool results as raw [USER]/<tool_result> messages. The current Phase 2 fix (`prepareMessagesForProvider`) strips XML wrappers from the assembled messages but does NOT change the fact that the full history is assembled and sent every call.

Which approach should the redesign take?

* **A** New `PromptAssembler` class that builds a fresh, compact message array for each LLM call (system prompt once, compact state note, current instruction, current-step tool results only — no prior chat turns replayed)
* **B** Surgical patch to AgentRunner's existing `messages.push()` calls — trim the messages array before calling `provider.stream()` to a rolling window of the last N turns
* **C** Keep full history for the live run but stop including it on `continue`/resume calls (resume gets compact context only)
* **D** Apply option A for code mode, option C for ask/plan mode

Additional sub-questions:

* What is the maximum number of prior conversation turns that should be sent to the LLM in a single call?
* Should the stable system prompt still be sent on every call, or once at session start only?

**Answer:**


* Choose **A**.
* Build a new `PromptAssembler` and make it the only prompt-construction path for code mode execution.
* Do not keep transcript replay as the primary context source.
* For code mode, each LLM call should include only:

  1. the stable system prompt,
  2. one compact execution-state summary,
  3. one compact workspace/project summary,
  4. the current user instruction or current run objective,
  5. current-step structured tool results only,
  6. optionally one very short prior assistant milestone summary if needed.
* Maximum prior conversation turns to send in a single call: **0 by default** for code mode.
  If you insist on a small carry-over, cap it at **1 assistant milestone summary + 1 latest user instruction**, not raw historical turns.
* The stable system prompt should still be sent **on every call**, because provider sessions are stateless at the API level and you need deterministic behavior per request.
* Do not rely on “once at session start only” unless your provider/session layer truly guarantees persistent server-side context, which this flow should not assume.
* Ask/plan modes may keep a somewhat richer history later if needed, but this redesign should be implemented first and authoritatively for code mode.

---

---

## EQ-16: `nextAction` — structured or free text?

Items 6 and 11 require `nextAction` to be the authoritative resume pointer. The current execution state stores `nextAction` as a free-text string (e.g., "Write src/index.ts as the project entrypoint").

For the engine to actually execute from `nextAction` on resume without re-reading the transcript, it needs to know WHAT tool to call and with WHAT inputs.

* **A** Keep `nextAction` as free text — the LLM reads it and decides which tool to call (current approach, simpler but still requires an LLM call to interpret intent)
* **B** Make `nextAction` structured: `{ tool: string, input: Record<string, unknown>, description: string }` — the engine can dispatch the tool directly without an interpretation LLM call
* **C** Two-field approach: `nextAction` (free text for LLM context) + `nextToolCall` (structured, for direct dispatch)

**Answer:**


* Choose **C**.
* Store both:

  * `nextAction`: short human-readable text for summaries/UI/debugging
  * `nextToolCall`: structured tool payload for direct resume
* Recommended shape:

  ```ts
  nextAction: string;
  nextToolCall?: {
    tool: string;
    input: Record<string, unknown>;
    description?: string;
  };
  ```
* Resume behavior:

  * if `nextToolCall` exists and is valid, dispatch it directly,
  * if it is missing or invalid, fall back to `nextAction` plus one compact recovery LLM call,
  * do not reconstruct resume from transcript.
* This is the best balance between reliability and observability.

---

---

## EQ-17: Terminal/wait states — signaling and UX

Items 7 and 18 require the agent to stop cleanly when it reaches a wait state. The log confirms: after writing `open_questions.md` (the terminal deliverable), the agent continued listing `.bormagi/` and reading `project.json` instead of stopping.

**A — How does the agent signal a wait state?**

* **A1** The agent calls `update_task_state` with a special `sessionPhase` value (e.g., `WAITING_FOR_USER_INPUT`) — framework detects this and ends the run loop
* **A2** A new virtual tool `signal_wait_state(reason, state)` — explicit and self-documenting
* **A3** The framework detects the condition automatically (e.g., file was written that matches task objective) without the agent needing to signal it
* **A4** The agent emits a structured completion payload (`__bormagi_outcome__: WAITING_FOR_USER_INPUT`)

**B — What does the user see when a wait state is reached?**

* **B1** A formatted message in chat: "Paused — waiting for your input on `open_questions.md`" with no further agent output
* **B2** Silent stop — agent just stops, no special message
* **B3** A status bar update only (no chat message)

**Answer:**

* For signaling, choose **A1**.
* Use the existing task/execution-state update path rather than adding a new virtual tool.
* Add a required enum such as:

  * `RUNNING`
  * `WAITING_FOR_USER_INPUT`
  * `BLOCKED_BY_VALIDATION`
  * `COMPLETED`
  * `RECOVERY_REQUIRED`
* When the agent or framework sets `sessionPhase = WAITING_FOR_USER_INPUT`, the framework must immediately terminate the run loop after persisting state.
* Also allow framework-side auto-detection as a secondary safeguard, but the primary mechanism should be explicit state update, not heuristic detection.
* For UX, choose **B1**.
* Show a short formatted chat message such as:

  * `Paused — waiting for your input on open_questions.md`
* Then stop with no further tool calls or narration.
* Do not use silent stop as the default, because it looks like failure.
* Do not rely on status-bar-only signaling.

---

---

## EQ-18: Recovery mode — trigger subset and user experience

Item 19 describes 5 recovery triggers. For the first implementation:

**A — Which triggers should be active?**

* **A1** All 5 from the spec: repeated blocked reads, repeated `continue` with no progress, artifact-registry/write conflict, protocol text in transcript, missing/invalid `nextAction`
* **A2** Only the most impactful subset: missing/invalid `nextAction` + protocol text in transcript
* **A3** Manual recovery only in v1 — explicit user command triggers rebuild, no automatic triggering

**B — What happens when recovery fires?**

* **B1** Framework silently rebuilds compact state from executed tool history and resumes automatically
* **B2** Framework rebuilds state and shows a brief notice ("Inconsistent state detected — rebuilding from execution history") before continuing
* **B3** Framework stops the run, shows the user a state report, and waits for user `continue` to resume

**Answer:**


* For triggers, choose **A1**, but implement them with simple thresholds.
* Active triggers in v1:

  1. repeated blocked reads,
  2. repeated `continue` with no progress,
  3. artifact-registry/write conflict,
  4. protocol text detected in assembled transcript,
  5. missing or invalid `nextAction` / `nextToolCall`.
* These are all real failure modes already observed, so deferring them would leave known loops unfixed.
* For behavior, choose **B2**.
* Recovery should:

  1. rebuild compact state from executed tool history and artifact state,
  2. show a brief notice,
  3. continue automatically if recovery succeeds.
* Example UX:

  * `Inconsistent execution state detected — rebuilding from execution history`
* If automatic recovery fails, then stop and enter `RECOVERY_REQUIRED`.
* Do not make normal users manually recover by default.
* Do not recover silently, because that hides important behavior during debugging and rollout.

---

---

## EQ-19: Artifact-aware write/edit selection (item 13)

Item 13 says: before any write, check artifact registry; if file exists, use `edit_file` instead of `write_file`. The log confirms `write_file open_questions.md` failing because the file already existed from a previous session.

Where should this check live?

* **A** In `ToolDispatcher.dispatch()` — before dispatching `write_file`, check artifact registry; if path exists, automatically redirect to `edit_file` with same content
* **B** In `AgentRunner` — intercept `write_file` calls in the tool dispatch branch and switch to `edit_file`
* **C** Prompt instruction only — tell agent to check artifact registry first (current behavior, fails as confirmed by log)
* **D** Both A and C — dispatch-layer enforcement + prompt instruction as defence-in-depth

When redirecting, should the framework silently redirect (agent sees success) or notify the agent that a redirect occurred?

**Answer:**

* Choose **D**.
* Enforcement must live in **`ToolDispatcher.dispatch()`**.
* Also keep a short prompt instruction for defence-in-depth, but do not rely on the model to get this right.
* Dispatcher behavior:

  * if `write_file(path)` targets an existing artifact/file, convert it to `edit_file(path, content)` before execution.
* The framework should **notify the agent in structured form** that a redirect occurred.
* Recommended result shape:

  ```ts
  {
    status: "success",
    toolName: "edit_file",
    redirectedFrom: "write_file",
    summary: "Existing file detected; redirected write_file to edit_file"
  }
  ```
* Do not silently redirect with no signal, because the execution state and model reasoning may otherwise drift.
* Do not expose this as normal chat text; keep it in the structured tool-result channel.

---

---

## EQ-20: Workspace classification fix (item 23)

The log shows "currently editing ` (empty)`" (session 1) and "currently editing `open_questions.md`" (session 2). Both are inaccurate — the first is a stale VS Code active editor state, the second points to a file the agent already finished writing.

The system prompt includes: `currently editing {lastActiveFile}, as of {date}`. This comes from VS Code's active editor tab, which drifts.

* **A** Remove "currently editing" from the system prompt entirely — it causes confusion more than it helps
* **B** Replace with the most recently written file by the agent this session (from execution state `filesWritten`)
* **C** Replace with the next planned file from the current batch (most useful for orientation)
* **D** Keep it but populate from execution state only, not from VS Code's active editor

**Answer:**


* Choose **A**.
* Remove `currently editing ...` from the system prompt entirely.
* It is unstable, often wrong, and not important enough to justify prompt noise.
* If orientation is needed, provide it in the compact execution-state summary instead, for example:

  * current batch id,
  * next planned file,
  * last completed file,
  * current task phase.
* Do not couple execution logic to VS Code active editor state.
* Do not keep this field in the stable system prompt.

---

---

## EQ-21: Scope of new plan relative to Phase 1–5 work

The previous session (Phases 1–5) already addressed several of the 25 items: tool result isolation, `.bormagi` blocking, discovery budget enforcement, transcript sanitisation, batch enforcement, architecture lock, ConsistencyValidator, and developer commands. 52 regression tests pass.

The log was recorded before those fixes were applied (or with `executionEngineV2=false`). The new requirements document largely confirms the same problems and extends them with items 3, 7, 13, 18, 19, and 23.

What should the new plan's scope be?

* **A** Treat Phase 1–5 as the baseline and plan only the remaining unaddressed items (3, 7, 13, 18, 19, 23 + flip V2 default)
* **B** Treat Phase 1–5 as a prior attempt — re-examine and re-implement everything from the 25-item list from scratch
* **C** Treat Phase 1–5 as the baseline, but first write a verification pass (run tests with `executionEngineV2=true` and do a live session test) to confirm what actually works before planning remaining items

**Answer:**

* Choose **C**.
* Treat Phases 1–5 as the baseline.
* Do **not** restart the whole 25-item program from scratch.
* First do a verification pass with:

  1. `executionEngineV2=true`,
  2. the current regression suite,
  3. at least one live greenfield session,
  4. at least one continue/resume session,
  5. at least one wait-state scenario.
* Then plan only what is still unaddressed or not actually working in production behavior.
* Expected likely remaining scope:

  * item 3 (prompt assembly redesign),
  * item 7 / 18 (wait-state and milestone finaliser),
  * item 13 (artifact-aware write/edit enforcement),
  * item 19 (recovery mode),
  * item 23 (workspace classification cleanup),
  * flip V2 default after verification.
* This is the most practical and lowest-risk path.

---


---
# Open Questions — New Tool Stack & Skill Upgrade (0_newtools / 0_newtools_detailed_design)

> Questions raised while analysing `docs/New-Requirements/0_newtools.md` and `docs/New-Requirements/0_newtools_detailed_design.md` against the current codebase.
> **Do not begin implementation until all questions below are answered.**

---

## Section NT-A — Tool Implementation Location

### NT-1: Where should the new tools be implemented?

* **A** New tool handlers inside existing `filesystem-server.ts` (current pattern for read_file, write_file, etc.)
* **B** New standalone MCP builtin server (e.g. `code-nav-server.ts`) keeping `filesystem-server.ts` unchanged
* **C** Tier 1 read/search tools as virtual tools in ToolDispatcher (no MCP round-trip, faster, simpler)

Impact: A keeps everything together but filesystem-server.ts is already large. B isolates concerns but adds server overhead. C is fastest for stateless operations but mixes responsibilities.

**Answer:**
**ANSWER**
Choose **B**.

Implement the new tool stack in a new standalone builtin server such as `code-nav-server.ts`.

Reasoning:

* `filesystem-server.ts` already owns basic file primitives; adding grep/glob/range/symbol logic there will overgrow it further.
* Tier 1 tools are not just dispatch tricks; they are reusable navigation capabilities and deserve a proper tool boundary.
* Putting them directly inside `ToolDispatcher` would blur orchestration vs tool execution responsibilities and make testing harder.
* A separate builtin server gives clear ownership, simpler telemetry, clearer permissions, and a clean place to add Tier 2/Tier 3 later.

Implementation guidance:

* Keep `filesystem-server.ts` unchanged except for any shared helper extraction.
* Add `code-nav-server.ts` for:

  * `glob_files`
  * `grep_content`
  * `read_file_range`
  * `read_head`
  * `read_tail`
  * `read_match_context`
  * later symbol tools
* ToolDispatcher should only:

  * expose/hide tools by mode,
  * enforce permissions/budgets,
  * dispatch to the builtin server.

---

---

## Section NT-B — `search_files` vs `grep_content`

### NT-2: Should `search_files` be deprecated or upgraded?

The existing `search_files` tool does regex search but with simpler output than the proposed `grep_content` (which adds structured JSON, context lines, include/exclude globs, result caps).

* **A** Keep `search_files` as-is and add `grep_content` as a separate richer tool
* **B** Upgrade `search_files` in-place to match the `grep_content` spec (same tool name, backward compat)
* **C** Add `grep_content` as new preferred tool and deprecate `search_files` for future removal

**Answer:**
**ANSWER**
Choose **C**.

Add `grep_content` as the new preferred tool and deprecate `search_files` for later removal.

Reasoning:

* `grep_content` is materially richer and should become the canonical search primitive.
* Upgrading `search_files` in place risks hidden compatibility breaks and ambiguous semantics.
* Keeping both forever would create prompt/tool-choice confusion.

Implementation guidance:

* Keep `search_files` temporarily for backward compatibility.
* Mark it deprecated in tool metadata and agent instructions.
* Update prompts/skills to prefer `grep_content`.
* Add telemetry to measure residual `search_files` usage.
* Remove `search_files` in a later cleanup once no active flows depend on it.

---

---

## Section NT-C — Symbol Navigation Implementation

### NT-3: What parsing approach for Tier 2 symbol tools?

`find_symbols`, `read_symbol_block`, `replace_symbol_block`, `insert_before/after_symbol` require parsing symbol boundaries.

* **A** Regex heuristics — match class X, function X, const X = etc. Fast, zero deps, works cross-language, brittle for complex nesting
* **B** TypeScript Compiler API — precise AST for .ts/.js only, adds ~1-2 MB to bundle
* **C** tree-sitter npm — language-agnostic, robust, but adds native binary (~10 MB) and per-language grammars
* **D** Defer symbol tools entirely — implement only Tier 1 now and revisit Tier 2 with a clearer commitment

**Answer:**
**ANSWER**
Choose **B**.

Use the **TypeScript Compiler API** for Tier 2 symbol tools, scoped to `.ts`, `.tsx`, `.js`, and `.jsx`.

Reasoning:

* The Bormagi codebase is TypeScript-heavy, so this gives high value immediately.
* It is much more reliable than regex heuristics for classes, methods, exported functions, and nested structures.
* It avoids the operational complexity and bundle/native overhead of tree-sitter in the first implementation.
* Regex heuristics are too brittle for safe edit tools like `replace_symbol_block`.

Implementation guidance:

* Tier 2 symbol tools should initially support TS/JS family files only.
* For unsupported languages, return a structured `blocked` or `unsupported_language` result.
* Do not delay Tier 2 entirely; it is worth doing once Tier 1 is stable.

---

---

## Section NT-D — Discovery Budget Redesign

### NT-4: Should the discovery budget be extracted into a dedicated module?

The spec defines a new multi-category budget (whole-file reads <=2, targeted reads <=12, grep calls <=4, glob calls <=3) more nuanced than the current single-counter in `ToolDispatcher._guardState`.

* **A** Extract into `src/agents/execution/DiscoveryBudget.ts` with per-category counters — clean and testable, refactor needed
* **B** Extend existing `_guardState` in ToolDispatcher with new counters — minimal disruption, no new file
* **C** Keep current budget unchanged, only add new tool implementations without touching budget logic

**Answer:**
**ANSWER**
Choose **A**.

Extract the budget into a dedicated `DiscoveryBudget.ts` module.

Reasoning:

* The new policy is no longer a simple counter; it is a real rules engine with categories and reset semantics.
* Keeping it inside `_guardState` will make ToolDispatcher larger and harder to test.
* A dedicated module is cleaner, reusable, and easier to regression-test.

Implementation guidance:

* Create `src/agents/execution/DiscoveryBudget.ts`.
* It should own:

  * counters by category,
  * consecutive-discovery tracking,
  * reset rules,
  * blocking decisions,
  * structured violation results.
* ToolDispatcher should call this module, not implement the logic inline.

---

---

## Section NT-E — `multi_edit` Atomicity

### NT-5: How strict must the atomicity guarantee be for `multi_edit`?

* **A** In-memory: apply all edits in-memory first, validate, then write all files at once
* **B** Backup-and-restore: copy target files to .tmp before applying; restore all on failure
* **C** Best-effort: apply sequentially; on failure report which succeeded and which failed, no rollback
* **D** Per-file atomic (temp+rename): each file written via temp file rename, no cross-file coordination

**Answer:**
**ANSWER**
Choose **B**.

Use **backup-and-restore** for the first implementation.

Reasoning:

* Cross-file atomicity matters for multi-edit.
* In-memory-only validation is not enough because writes can still fail mid-application.
* Best-effort is too weak for a tool whose value proposition includes coordinated edits.
* Per-file atomic rename is useful but does not solve multi-file rollback by itself.

Implementation guidance:

* Before applying edits, snapshot all target files to temporary backups.
* Apply edits.
* If any edit/write fails, restore all touched files from backup.
* Return a structured result showing rollback occurred.
* This is the best practical balance without overengineering.

---

---

## Section NT-F — Text Externalization Scope

### NT-6: What is the intended scope of the hardcoded-text externalization work?

Codebase is already ~90% externalized. Remaining inline strings:

1. Fallback contract strings in `src/context/ModePromptLoader.ts`
2. HTML labels/help text in `src/ui/AgentSettingsPanel.ts`
3. Inline JS strings in `media/chat.html`
4. Default agent prompt fragment in `src/agents/AgentManager.ts`
5. A few remaining tool-blocked messages in `ToolDispatcher.ts`

* **A** Externalize only strings introduced by the new tool work
* **B** Externalize the full remaining set (items 1-5) as a dedicated early phase before tool implementation
* **C** Externalize incrementally — fix any file touched during tool implementation, leave others for later

**Answer:**
**ANSWER**
Choose **C**.

Externalize incrementally: if a file is touched during this tool-stack rollout, externalize its remaining inline user-facing strings before closing the change.

Reasoning:

* A separate early full externalization phase would add unnecessary scope and delay.
* Only externalizing brand-new strings is too weak and leaves obvious inline debt in touched files.
* Incremental cleanup is the practical middle path.

Implementation guidance:

* Mandatory rule: if a tool-stack change touches one of the listed files, externalize the remaining inline user-facing strings in that file.
* Do not open unrelated files solely for text cleanup in this phase.

---

---

## Section NT-G — Phase 6 / V2 Default Flip

### NT-7: Should Phase 6 (flip `executionEngineV2` default to `true` and remove V1 branches) be part of this new plan?

This is the only outstanding item from the previous execution-layer plan and would clean up ~1000 lines of dead V1 code from `AgentRunner.ts`.

* **A** Include as Phase 0 of the new plan — do it first before adding new tools (cleaner codebase)
* **B** Do it as a small independent task in parallel
* **C** Defer until new tools are stable — avoids touching AgentRunner.ts twice in quick succession

**Answer:**
**ANSWER**
Choose **B**.

Do it as a **small independent task in parallel**, but do not block the tool-stack rollout on completing full V1 removal.

Reasoning:

* V2 default flip is important and should happen soon.
* But making it a hard prerequisite for the new tool stack couples two substantial tracks unnecessarily.
* Full V1 branch removal will touch the hot path and should not be bundled into every tool-stack change.

Implementation guidance:

* Parallel task 1:

  * enable `executionEngineV2=true` by default after verification,
  * keep V1 available briefly behind fallback if needed.
* Parallel task 2:

  * remove dead V1 branches once regression/live-session verification passes.
* The tool-stack project should assume V2 path as the target integration surface.

---

---

## Section NT-H — Mode-Specific Tool Permissions

### NT-8: How should new edit tools be blocked in read-only modes (ask/plan/review)?

* **A** Via `filterToolsByMode()` only — edit tools simply don't appear in the tool list in read-only modes
* **B** Via ToolDispatcher only — tools appear in the list but calls are rejected with a structured blocked result
* **C** Both — hide in prompt AND reject at dispatch (defense in depth, current pattern for .bormagi blocking)

**Answer:**
**ANSWER**
Choose **C**.

Use both visibility filtering and dispatch-layer enforcement.

Reasoning:

* Hiding tools reduces bad model choices.
* Dispatcher blocking is still required for safety and consistency.
* This matches the existing defense-in-depth approach and is the right pattern for edit tools.

Implementation guidance:

* `filterToolsByMode()` should hide edit tools in ask/plan/review.
* ToolDispatcher should still reject any illegal call with a structured blocked result.
* Do not rely on prompt/tool visibility alone.

---

---

## Section NT-I — Skill Playbooks

### NT-9: Should new skill playbooks (codebase-navigator, implement-feature, bug-investigator, dependency-auditor) be included in this plan?

* **A** Add as new agent definitions in `.bormagi/agents-definition/<name>/system-prompt.md` — selectable in UI
* **B** Add as injectable skill fragments in `src/skills/` — loaded on demand
* **C** Encode as additions to existing mode prompts (code.md, ask.md)
* **D** Skip skill playbooks — focus on tool implementation only, add skills afterwards

**Answer:**
**ANSWER**
Choose **B**.

Add them as **injectable skill fragments** in `src/skills/`, loaded on demand.

Reasoning:

* These are reusable operating playbooks, not new persona-level agents.
* Agent-definition proliferation would overcomplicate the UI and agent catalog.
* Hardcoding them into mode prompts would make mode prompts too large and less composable.
* Skill fragments give the best balance of reuse, control, and future extensibility.

Implementation guidance:

* Add:

  * `src/skills/codebase-navigator.md`
  * `src/skills/implement-feature.md`
  * `src/skills/bug-investigator.md`
  * `src/skills/dependency-auditor.md`
* Load them based on task type/mode/tooling context.
* Keep initial skill loading rules simple and deterministic.

---

---
## Section P — Architecture & Scope

### PQ-1: Relationship between the two source documents

> ⚠️ **Correction note:** The original question incorrectly referenced `0high_priority fixes.md` (Phases A–J) as a source document. That file is a separate log-analysis artifact and was NOT one of the specified inputs. The actual two source documents are:
> - `00-fixing_agent_productivity.md` — 15-point strategy/decision record (single `executionEngineV2` flag, rollout approach)
> - `00-fixing-agent_productivity_detailed_desgin.md` — 10-phase developer-ready backlog (Phases 0–10)
>
> These two documents are **complementary, not competing**. The strategy doc defines the flag approach and rollout order; the detailed design defines what to implement under that flag. There is no conflict to resolve.

**Guidance (from earlier answer, updated to correct context):**

* `00-fixing_agent_productivity.md` is the **rollout strategy**: one flag, all fixes together, test then flip default
* `00-fixing-agent_productivity_detailed_desgin.md` is the **implementation spec**: phases 0–10
* Use the strategy doc to constrain scope (no flag proliferation, no permanent dual-mode)
* Use the detailed design as the target architecture
* Do **not** implement every architectural idea if the existing code can be fixed more simply
* Start from confirmed broken behaviors; borrow structure from the detailed design only where needed

**ANSWER** this is architectural change , approved by user in exception to the general rules
---

### PQ-2: Already-implemented phases — include in plan or skip?

**Answer:**
**ANSWER**
Choose **A** — plan covers **remaining gaps only** and lists completed items as baseline.

Pragmatic rule:

* Do not re-plan or re-describe completed work in depth
* Add a short “baseline already implemented” section
* Focus implementation effort on:

  * wiring gaps
  * activation gaps
  * runtime path gaps
  * verification gaps

This keeps the plan shorter, safer, and easier to execute.

---

## Section Q — AgentRunner Split (Phase 1.4 / Phase B)

### PQ-3: Is splitting AgentRunner a hard requirement?

**Answer:**
Choose **C** — **incremental extraction**.

Do **not** make a full split a hard prerequisite.

Pragmatic rule:

* First priority is **fixing wiring and runtime behavior**
* Extract only the parts that directly reduce risk:

  1. resume logic
  2. milestone finalization / stop-wait-complete logic
  3. recovery orchestration

Suggested sequence:

* extract `ResumeController`
* extract `MilestoneFinalizer`
* keep `AgentRunner` as coordinator for now
* extract more only after behavior is stable

This is much safer than a big-bang split of a 1,900+ line hot-path file. The repo confirms `AgentRunner.ts` is still very large and central, so a full immediate split would be high-risk. ([GitHub][1])

---

## Section R — StepContract and LLM Output (Phase 1.2)

### PQ-4: How should StepContract work with Claude's tool_use API?

**Answer:**
**ANSWER**
Choose **B** — infer `StepContract` from the existing `tool_use` flow.

Pragmatic rule:

* Do **not** introduce a new virtual tool unless absolutely necessary
* Keep Claude’s native `tool_use` flow
* Wrap runtime behavior internally as:

  * tool call → `StepContract(kind="tool")`
  * silent text-only terminal output → classify as `pause` / `complete` / `blocked`

Why:

* less plumbing
* less provider-specific complexity
* preserves existing provider behavior
* easier rollout

So `StepContract` should be an **internal framework concept**, not a new tool the model has to learn.

---

## Section S — Execution Phase FSM (Phase 1.1)

### PQ-5: New FSM vs extending existing SessionPhase?

**Answer:**
**ANSWER**
Choose **B** — keep `runPhase` for coarse terminal states and add a separate `executionPhase` for granular sub-states.

Pragmatic rule:

* Do not replace working persisted state unless necessary
* Keep current stable terminal states:

  * `RUNNING`
  * `WAITING_FOR_USER_INPUT`
  * `BLOCKED_BY_VALIDATION`
  * `COMPLETED`
  * `PARTIAL_BATCH_COMPLETE`
  * `RECOVERY_REQUIRED`
* Add transient in-run sub-state:

  * `INITIALISING`
  * `DISCOVERING`
  * `PLANNING_BATCH`
  * `EXECUTING_STEP`
  * `VALIDATING_STEP`
  * `RECOVERING`

This gives you the observability and control you want without breaking existing state persistence.

---

## Section T — TypeScript Compiler API (Phase 6)

### PQ-6: Is the TypeScript Compiler API required for Phase 6, or is the regex approach sufficient?

**Answer:**
**ANSWER**
Choose **A** — the current regex approach is **sufficient for now**.

Pragmatic rule:

* Since symbol tools are already implemented and bundle size matters, do not reopen this now
* Treat TS Compiler API as a future enhancement only if regex proves materially unreliable in real sessions

So for this implementation batch:

* Phase 6 is considered **done enough**
* focus on execution/runtime productivity issues instead of redoing symbol parsing

If later needed, do it as a separately loadable module, not part of this batch.

---

## Section U — Task Classifier (Phase 8.1)

### PQ-7: Should TaskClassifier use LLM or rule-based classification?

**Answer:**
**ANSWER**
Choose **A** — **rule/keyword-based classification only**.

Pragmatic rule:

* deterministic
* zero extra cost
* fast
* easier to debug

Use simple rules first:

* “read document … write questions … wait” → `document_then_wait`
* “start implementation / scaffold / create project” + no codebase → `greenfield_scaffold`
* “fix / patch / bug / adjust existing file” → `existing_project_patch`
* “refactor multiple files” → `multi_file_refactor`
* “analyse / investigate / tell me what is wrong” → `investigate_then_report`
* explicit “plan only” / “do not implement” → `plan_only`

Only add LLM classification later if real ambiguity remains.

---

## Section V — Silent Execution Enforcement (Phase 9.2)

### PQ-8: How should narration be handled in strict silent mode?

**Answer:**
**ANSWER**
Choose **A** — strip it silently and do not count it as an iteration.

Pragmatic rule:

* if `silentExecution=true`, any pre-tool narration is ignored
* do not reprompt the model
* do not show “narration suppressed”
* do not burn another iteration unless there is no usable tool call at all

Fallback:

* if the model emits narration **without** a valid tool call or terminal signal, then one terse internal reprompt is acceptable
* but the default path should be silent stripping

This is the simplest and least disruptive behavior.

---

## Section W — executionEngineV2 Default Flip (Phase 10)

### PQ-9: Can the default flip happen within this implementation batch?

**Answer:**
**ANSWER**
Choose **B** — live session verification is required before the default flip.

Pragmatic rule:

* regression tests are necessary but not sufficient
* the exact problem you are fixing is a **runtime flow problem**
* so one or more real end-to-end live sessions must pass before flipping default

The repo still shows `executionEngineV2` defaulting to `false`, so this should stay unchanged until the live path is verified. ([GitHub][1])

Implementation approach:

1. finish fixes
2. run regression suite
3. run live session(s) against known bad scenarios
4. flip default only after those pass

---

## Section X — Dispatcher-Level Edit Tool Blocking (Phase 9.1)

### PQ-10: Should ToolDispatcher block write/edit tools in ask/plan modes?

**Answer:**
**ANSWER**
Choose **A** — add dispatcher-level blocking.

Pragmatic rule:

* prompt-level prevention is not enough
* mode-based filtering is helpful but not sufficient
* dispatcher must reject write/edit tools in ask/plan modes with a structured error

This is cheap, clear, and worth doing.

Implementation behavior:

* in ask/plan/review modes, dispatcher rejects:

  * `write_file`
  * `edit_file`
  * `multi_edit`
  * symbol edit tools
  * any other mutation tool
* return structured blocked result with reason:

  * `mode_disallows_mutation`

This is not over-engineering; it is a simple safety rail.

---

## Recommended implementation summary

Flat decision summary for the team:

* **PQ-1:** C — merged unified plan
* **PQ-2:** A — baseline only, plan remaining gaps
* **PQ-3:** C — incremental extraction, not full split first
* **PQ-4:** B — infer StepContract internally from native tool_use
* **PQ-5:** B — keep `runPhase`, add `executionPhase`
* **PQ-6:** A — regex symbol tools are sufficient for now
* **PQ-7:** A — rule-based task classifier only
* **PQ-8:** A — silently strip narration in silent mode
* **PQ-9:** B — do not flip V2 default until live verification passes
* **PQ-10:** A — dispatcher must block mutation tools in ask/plan modes

Ready for the next question set.

[1]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/AgentRunner.ts "raw.githubusercontent.com"
