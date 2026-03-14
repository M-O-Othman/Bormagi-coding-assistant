Additional information that would sharpen file names is your preferred folder layout for new runtime modules, but there is enough to define a developer-ready backlog now.

# Developer-ready phased backlog

## Phase 0 — Stabilize the hot path before more features

### 0.1 Reformat core execution files

Files:

* `src/agents/AgentRunner.ts`
* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/execution/PromptAssembler.ts`
* `src/agents/execution/ConsistencyValidator.ts`

Actions:

* reformat into normal multiline TypeScript
* keep logic unchanged
* add lint/format guard in CI for these files

Acceptance criteria:

* no behavioral change
* diffs become reviewable
* tests still pass

### 0.2 Add active-path startup logging

Files:

* `src/agents/AgentRunner.ts`
* logging utility if separate

Actions:

* log once per run:

  * execution engine version
  * prompt builder used
  * silent mode on/off
  * task template
  * transcript-free code mode on/off
  * recovery enabled on/off

Acceptance criteria:

* every session log clearly shows which runtime path is active

### 0.3 Remove unreliable “currently editing”

Files:

* prompt/system-prompt assembly code
* any context provider feeding active editor path

Actions:

* remove `currently editing ...` from code-mode prompt
* replace with:

  * `lastCompletedFile`
  * `nextPlannedFile`
  * `currentBatchId`
    from execution state only

Acceptance criteria:

* no session prompt contains stale editor path

### 0.4 Make workspace summary descriptive only

Files:

* `src/agents/execution/PromptAssembler.ts`

Actions:

* remove imperative language like “Start by creating ...”
* keep only facts:

  * scaffold present or absent
  * relevant files
  * repo type
  * top-level folders

Acceptance criteria:

* workspace block never instructs action

---

## Phase 1 — Build an Execution Kernel

## Goal

Move control from transcript/model to framework/state.

### 1.1 Create finite-state machine

New files:

* `src/agents/execution/ExecutionPhase.ts`
* `src/agents/execution/ExecutionStateMachine.ts`

Types:

```ts
export type ExecutionPhase =
  | "INITIALISING"
  | "DISCOVERING"
  | "PLANNING_BATCH"
  | "EXECUTING_STEP"
  | "VALIDATING_STEP"
  | "WAITING_FOR_USER_INPUT"
  | "COMPLETED"
  | "BLOCKED"
  | "RECOVERING";
```

Actions:

* centralize allowed transitions
* reject illegal transitions
* remove scattered phase mutation

Acceptance criteria:

* all phase changes go through state machine
* wait/completed states are explicit

### 1.2 Introduce StepContract

New files:

* `src/agents/execution/StepContract.ts`

Types:

```ts
export type StepContract =
  | { kind: "tool"; tool: string; input: Record<string, unknown>; reason: string }
  | { kind: "pause"; phase: "WAITING_FOR_USER_INPUT"; message: string }
  | { kind: "complete"; message: string }
  | { kind: "blocked"; reason: string; recoverable: boolean };
```

Actions:

* require code-mode LLM to return one `StepContract`
* validate before execution
* reject free-form narrative in silent mode

Acceptance criteria:

* code-mode planner output is always one structured step

### 1.3 Create ExecutionLedger

New files:

* `src/agents/execution/ExecutionLedger.ts`

Structure:

* step id
* phase
* tool name
* input summary
* result summary
* touched paths
* validator outcome
* next step
* recovery event

Actions:

* append after every executed step
* use ledger for resume and recovery
* stop using transcript as source of truth

Acceptance criteria:

* resume can reconstruct from ledger alone

### 1.4 Split AgentRunner responsibilities

Files:

* `src/agents/AgentRunner.ts`

Actions:

* reduce `AgentRunner` to orchestration shell
* move:

  * phase control
  * step execution
  * resume logic
  * recovery logic
    into dedicated modules

Suggested new modules:

* `ExecutionKernel.ts`
* `ResumeController.ts`
* `MilestoneFinalizer.ts`
* `RecoveryController.ts`

Acceptance criteria:

* `AgentRunner.ts` becomes thin coordinator
* core logic lives in dedicated classes

---

## Phase 2 — Make code mode transcript-free

## Goal

Code execution must use compact state, not conversation replay.

### 2.1 Make PromptAssembler the only code-mode prompt path

Files:

* `src/agents/AgentRunner.ts`
* `src/agents/execution/PromptAssembler.ts`

Actions:

* delete or bypass old code-mode prompt assembly path
* all code-mode provider calls go through `PromptAssembler`
* non-code modes may keep separate paths temporarily

Acceptance criteria:

* code mode never uses raw transcript history assembly

### 2.2 Stop persisting raw tool results into conversation messages

Files:

* `src/agents/AgentRunner.ts`
* transcript persistence code
* message store code if separate

Actions:

* in code mode:

  * tool results go to `currentStepToolResults`
  * tool results go to `ExecutionLedger`
  * tool results do not get appended to `messages`
* persist only compact human-safe summaries

Acceptance criteria:

* provider prompt contains current-step tool results only
* no `<tool_result>` or tool protocol wrappers in code-mode prompts

### 2.3 Add provider-prompt sanitizer assertion

Files:

* `PromptAssembler.ts`
* `TranscriptSanitiser.ts`

Actions:

* validate assembled code-mode prompt before send
* reject prompt if it contains:

  * `<tool_result`
  * `[write_file:`
  * `TOOL:`
  * raw XML wrappers
  * repeated full system prompt fragments

Acceptance criteria:

* protocol leakage cannot silently re-enter code-mode provider prompts

### 2.4 Add prompt-size regression tests

New tests:

* `tests/execution/prompt-assembly.spec.ts`

Acceptance criteria:

* repeated calls do not grow linearly with transcript length
* code-mode prompt size remains compact across multiple tool steps

---

## Phase 3 — Resume, stop, and recovery hardening

## Goal

No more “why did you stop?” and no more transcript-based continue.

### 3.1 Make `nextToolCall` authoritative

Files:

* `ResumeController.ts`
* execution state persistence code

Actions:

* persist after every successful step:

  * `nextAction`
  * `nextToolCall`
* on `continue`:

  * if valid `nextToolCall` exists, dispatch directly
  * do not ask LLM to reinterpret history

Acceptance criteria:

* normal continue path requires no interpretive LLM call

### 3.2 Add MilestoneFinalizer

New files:

* `src/agents/execution/MilestoneFinalizer.ts`

Responsibilities:

* inspect completed step
* decide:

  * continue
  * validate
  * wait
  * complete
  * block

Rules examples:

* wrote `open_questions.md` for prerequisite-gathering task → wait
* batch completed with file mutations → validate
* last batch done and validator passed → complete

Acceptance criteria:

* milestone outputs produce deterministic stop/continue behavior

### 3.3 Add RecoveryController

New files:

* `src/agents/execution/RecoveryController.ts`

Triggers:

* missing/invalid `nextToolCall`
* repeated continue without progress
* repeated blocked tool calls
* prompt contamination detected
* artifact/write mismatch
* duplicate step loops

Actions:

* rebuild compact state from `ExecutionLedger`
* regenerate one valid next step
* log recovery event
* continue or block cleanly

Acceptance criteria:

* repeated “continue” loops are broken by controlled recovery

### 3.4 Add explicit pause/completion UX

Files:

* chat response rendering
* execution finalization path

Actions:

* when phase enters `WAITING_FOR_USER_INPUT`, emit one short message
* when `COMPLETED`, emit one short completion summary
* do not continue looping afterward

Acceptance criteria:

* no silent stop without explicit terminal or wait signal

---

## Phase 4 — Discovery budget redesign

## Goal

Budgets must route progress, not just punish reads.

### 4.1 Create `DiscoveryBudget.ts`

New files:

* `src/agents/execution/DiscoveryBudget.ts`

Track:

* whole-file reads
* targeted reads
* grep calls
* glob calls
* consecutive discovery-without-mutation

Suggested defaults:

* whole-file reads <= 2
* targeted reads <= 12
* grep <= 4
* glob <= 3
* consecutive discovery <= 5

Acceptance criteria:

* all budget logic leaves `ToolDispatcher`

### 4.2 Add “budget + route” decisions

Output states:

* `ALLOW`
* `BLOCK`
* `ROUTE_TO_NEXT_STEP`
* `REQUIRES_PLAN`

Actions:

* if budget exhausted and `nextToolCall` exists → route
* if budget exhausted and no next step → block cleanly
* if reread of same file detected → block and suggest targeted alternative

Acceptance criteria:

* budget exhaustion no longer causes confused wandering

### 4.3 Update ToolDispatcher to delegate

Files:

* `src/agents/execution/ToolDispatcher.ts`

Actions:

* remove embedded counter logic
* call `DiscoveryBudget`
* keep dispatcher focused on:

  * permission checks
  * artifact-aware routing
  * actual dispatch

Acceptance criteria:

* dispatcher becomes simpler and testable

---

## Phase 5 — New navigation tool stack

## Goal

Give agents search-first, targeted-read tools so they stop over-reading.

### 5.1 Create builtin navigation server

New files:

* `src/tools/code-nav-server.ts`
* `src/tools/common/pathPolicy.ts`
* `src/tools/common/resultEnvelope.ts`
* `src/tools/common/fileFilters.ts`

Actions:

* implement separate builtin server
* do not bloat `filesystem-server.ts`

Acceptance criteria:

* navigation tools are isolated from basic file I/O primitives

### 5.2 Implement Tier 1 tools

New files:

* `src/tools/globFiles.ts`
* `src/tools/grepContent.ts`
* `src/tools/readFileRange.ts`
* `src/tools/readHead.ts`
* `src/tools/readTail.ts`
* `src/tools/readMatchContext.ts`

Requirements:

* structured JSON outputs
* caps and truncation metadata
* repo-relative normalized paths
* deny `.bormagi/**`, directories where invalid, binaries for text read

Acceptance criteria:

* all Tier 1 tools callable through dispatcher
* all have unit tests

### 5.3 Implement editing primitives

New files:

* `src/tools/replaceRange.ts`
* `src/tools/multiEdit.ts`
* `src/tools/common/editTransaction.ts`

`multi_edit` rule:

* use backup-and-restore rollback

Acceptance criteria:

* multi-file edit can rollback on failure
* return structured diff summary

### 5.4 Deprecate `search_files`

Files:

* tool registry
* prompt/skill files
* dispatcher metadata

Actions:

* add `grep_content`
* keep `search_files` temporarily
* mark deprecated
* add telemetry counter to measure remaining use

Acceptance criteria:

* new prompts/skills prefer `grep_content`
* old flows still work temporarily

---

## Phase 6 — Symbol-aware tooling

## Goal

Reduce full-file reads even further with safe TS-aware symbol operations.

### 6.1 Create TypeScriptSymbolService

New files:

* `src/tools/symbols/TypeScriptSymbolService.ts`

Use:

* TypeScript Compiler API

Support:

* `.ts`
* `.tsx`
* `.js`
* `.jsx`

Acceptance criteria:

* robust symbol boundaries for TS/JS family files

### 6.2 Implement symbol tools

New files:

* `src/tools/findSymbols.ts`
* `src/tools/readSymbolBlock.ts`
* `src/tools/replaceSymbolBlock.ts`
* `src/tools/insertBeforeSymbol.ts`
* `src/tools/insertAfterSymbol.ts`

Behavior:

* unsupported language returns structured blocked result

Acceptance criteria:

* symbol edits work on TS/JS files without whole-file rewrite

---

## Phase 7 — Validation as a hard post-write gate

## Goal

Do not let the agent build on a broken workspace.

### 7.1 Integrate ConsistencyValidator into the write lifecycle

Files:

* `ConsistencyValidator.ts`
* `ExecutionKernel.ts`
* `MilestoneFinalizer.ts`

Actions:

* after every mutating step:

  * run validator
  * auto-fix safe issues if enabled
  * block on critical issues
* record result in ledger

Acceptance criteria:

* mutating steps cannot silently leave workspace inconsistent

### 7.2 Add validator severity model

Suggested severities:

* `info`
* `warning`
* `critical`

Critical examples:

* missing dependency required by new import
* invalid script entrypoint
* architecture mismatch
* missing created file from planned batch

Acceptance criteria:

* only critical issues block
* warnings are surfaced but do not stop flow

---

## Phase 8 — Task templates and skill system

## Goal

Reduce ambiguity by classifying task shape once.

### 8.1 Add task templates

New files:

* `src/agents/execution/TaskTemplate.ts`
* `src/agents/execution/TaskClassifier.ts`

Templates:

* `document_then_wait`
* `greenfield_scaffold`
* `existing_project_patch`
* `multi_file_refactor`
* `investigate_then_report`
* `plan_only`

Actions:

* classify once at start
* store in execution state
* use template to influence:

  * stop rules
  * allowed tool behavior
  * batch requirements
  * workspace-summary style

Acceptance criteria:

* “greenfield” banner can never override a `document_then_wait` task objective

### 8.2 Add skill playbooks as injectable fragments

New files:

* `src/skills/codebase-navigator.md`
* `src/skills/implement-feature.md`
* `src/skills/bug-investigator.md`
* `src/skills/dependency-auditor.md`

Actions:

* load by template/mode
* do not create separate agent personas for these

Acceptance criteria:

* skills remain composable and on-demand

---

## Phase 9 — Mode-specific permissions and silent execution hardening

## Goal

Reduce bad choices and narration noise.

### 9.1 Enforce edit-tool blocking in read-only modes

Files:

* mode filter logic
* dispatcher permission logic

Actions:

* use both:

  * hide in mode tool list
  * reject at dispatch

Acceptance criteria:

* edit tools unavailable in ask/plan/review
* blocked if somehow called anyway

### 9.2 Make silent execution strict

Files:

* planner output validation
* chat rendering
* execution kernel

Actions:

* in silent mode, planner may emit only:

  * one tool step
  * one pause
  * one completion
  * one blocked state
* reject narrative output

Acceptance criteria:

* user no longer needs to repeatedly say “do not narrate”

---

## Phase 10 — Default flip and cleanup

## Goal

Finish transition, then remove dead code.

### 10.1 Flip `executionEngineV2` default to true

Files:

* `package.json`
* settings docs
* startup config code if separate

Actions:

* flip only after:

  * regression suite passes
  * one live-session verification passes

Acceptance criteria:

* logs show V2 active by default

### 10.2 Remove V1 branches

Files:

* `AgentRunner.ts`
* related old prompt assembly / transcript flow code

Actions:

* remove dead V1 branches only after stable rollout
* keep one release overlap if necessary

Acceptance criteria:

* hot path is no longer hybrid

### 10.3 Fix repository metadata

Files:

* `package.json`

Actions:

* update repo/homepage/bugs URLs to current repo

Acceptance criteria:

* metadata matches actual GitHub repo

---

# Required tests

## Unit tests

* `ExecutionStateMachine` legal/illegal transitions
* `DiscoveryBudget` counters and routing outputs
* `PromptAssembler` produces compact code-mode prompts only
* protocol leakage rejection
* `.bormagi` blocking
* directory read blocking
* artifact-aware write/edit resolution
* `multi_edit` rollback
* symbol service on TS files

## Integration tests

* resume with `nextToolCall`
* wait state after `open_questions.md`
* continue after user answers
* budget exhaustion routes to next valid step
* code mode with silent execution produces no narration
* targeted reads replace whole-file wandering

## Live scenario tests

1. document → open questions → wait
2. greenfield scaffold with explicit batch
3. existing project bug fix with grep + targeted read + edit + validate
4. repeated continue without progress triggers recovery, not drift

---

# Acceptance criteria for the whole program

The solution is “good enough” only when all of these are true:

1. Code mode provider prompts are transcript-free and compact.
2. Tool results do not re-enter long-lived conversation history.
3. Resume uses `nextToolCall`, not transcript interpretation.
4. Wait/completed states stop cleanly and visibly.
5. Discovery budget either routes or blocks; it never just nags.
6. Invalid reads on directories and `.bormagi/**` are blocked before execution.
7. Agents prefer search-first and targeted reads over whole-file reads.
8. Post-write validation is automatic and blocking on critical issues.
9. Silent mode prevents narration, not just hides it.
10. V2 is the only active hot path after rollout.

---

# Recommended implementation order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 4
5. Phase 5
6. Phase 7
7. Phase 8
8. Phase 9
9. Phase 10
10. Phase 6 can run after Tier 1 tools are stable

That order gives you the highest chance of actually fixing productivity rather than just adding capabilities.


