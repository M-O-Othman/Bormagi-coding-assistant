Additional information that would help is whether you want the intelligent layer delivered behind a feature flag from day 1, but there is enough to define the implementation.

# Intelligent layer — implementation instructions

## 1. Purpose

Implement a **thin intelligent layer** that improves agent productivity **after** the execution/control-model fixes are complete.

It must not become:

* a second execution engine
* a second source of truth
* a hidden planner that bypasses framework rules
* a replacement for execution state, batch state, or dispatcher guards

Its job is only to improve:

* task classification
* tool choice
* read strategy
* validation timing
* batching hints
* recovery routing hints

## 2. Non-negotiable design constraints

The intelligent layer must obey these rules:

* **ExecutionState remains authoritative**
* **ToolDispatcher remains the enforcement point**
* **PromptAssembler remains the only prompt path for code mode**
* **DiscoveryBudget remains blocking**
* **ConsistencyValidator remains the post-write quality gate**
* **RecoveryManager remains the recovery mechanism**
* the intelligent layer may **suggest**
* it may not silently override hard guards
* it may not inject large prompt text
* it may not add extra LLM calls by default

## 3. Implementation model

Implement it as a **rule-based decision service**, not a new agent.

Use:

* deterministic rules
* scored heuristics
* small structured outputs
* no additional model call in v1

Do not implement:

* free-form planner
* chain-of-thought simulator
* hidden self-reflection loop
* recursive strategy engine

## 4. New modules to create

Create these files:

* `src/agents/intelligence/IntelligentLayer.ts`
* `src/agents/intelligence/TaskTemplateClassifier.ts`
* `src/agents/intelligence/ToolSelectionAdvisor.ts`
* `src/agents/intelligence/ReadStrategyAdvisor.ts`
* `src/agents/intelligence/BatchStrategyAdvisor.ts`
* `src/agents/intelligence/ValidationAdvisor.ts`
* `src/agents/intelligence/RecoveryAdvisor.ts`
* `src/agents/intelligence/types.ts`

Optional helper:

* `src/agents/intelligence/rules.ts`

## 5. Core interfaces

Create simple structured types.

```ts
export type TaskTemplate =
  | "document_then_wait"
  | "greenfield_scaffold"
  | "existing_project_patch"
  | "multi_file_refactor"
  | "investigate_then_report"
  | "plan_only";

export interface IntelligentContext {
  mode: "ask" | "plan" | "code" | "review";
  objective: string;
  workspaceSummary: WorkspaceSummary;
  executionState: ExecutionStateSnapshot;
  discoveryBudget: DiscoveryBudgetSnapshot;
  lastToolCall?: ToolCallRecord;
  lastToolResult?: ToolResultSummary;
}

export interface NextToolAdvice {
  recommendedTool: string | null;
  confidence: number;
  reason: string;
  alternativeTools?: string[];
  shouldBatch: boolean;
  shouldValidateAfter: boolean;
}

export interface ReadStrategyDecision {
  strategy: "glob_first" | "grep_first" | "targeted_read" | "full_read" | "symbol_read";
  reason: string;
}

export interface ValidationDecision {
  shouldValidateNow: boolean;
  severity: "none" | "light" | "full";
  reason: string;
}
```

Keep interfaces small and explicit.

## 6. Responsibilities by module

## 6.1 `TaskTemplateClassifier.ts`

Purpose:

* classify the task once near run start
* write result to execution state
* avoid greenfield/document confusion

Rules:

* if request includes “read”, “analyse”, “write questions”, “wait for answers” → `document_then_wait`
* if request includes “start implementation”, “scaffold”, “create project”, and workspace has no project files → `greenfield_scaffold`
* if project files exist and request includes “fix”, “patch”, “modify”, “update” → `existing_project_patch`
* if request includes “refactor”, “rename across”, “change architecture”, “multiple files” → `multi_file_refactor`
* if request includes “investigate”, “what is wrong”, “analyse log”, “find issue” → `investigate_then_report`
* if request explicitly says “plan only”, “do not implement” → `plan_only`

Requirements:

* deterministic
* no LLM call
* log the classification reason

## 6.2 `ToolSelectionAdvisor.ts`

Purpose:

* recommend the next best tool
* improve productivity without bypassing controls

Priority rules:

* prefer `glob_files` / `grep_content` over `list_files` for discovery
* prefer `read_file_range` / `read_match_context` over `read_file`
* prefer `read_symbol_block` for TS/JS symbol edits
* prefer `edit_file` over `write_file` if artifact exists
* prefer validation after mutating steps
* prefer `multi_edit` only when files are already known and linked

This advisor must never dispatch tools directly.
It only returns ranked recommendations.

## 6.3 `ReadStrategyAdvisor.ts`

Purpose:

* stop whole-file over-reading

Rules:

* if file unknown: `glob_first`
* if file known but symbol/pattern unknown: `grep_first`
* if exact match exists: `targeted_read`
* if TS/JS symbol known and symbol tools supported: `symbol_read`
* use `full_read` only when:

  * file is small enough, or
  * task explicitly requires full understanding, or
  * no better method exists

Hard rule:

* for files above threshold size, advisor should strongly discourage full-file read

Suggested thresholds:

* under 250 lines: full read acceptable
* 250–800 lines: targeted read preferred
* over 800 lines: full read discouraged unless explicitly justified

## 6.4 `BatchStrategyAdvisor.ts`

Purpose:

* decide whether to batch or execute single-step

Rules:

* single-file edit with exact target known → no batch required
* greenfield scaffold → batch required
* multi-file refactor → batch required
* unknown workspace or unstable context → no write batch until discovery completes
* if more than 2 related writes are expected → batch suggested

Outputs:

* `shouldBatch`
* `batchType`
* `reason`

## 6.5 `ValidationAdvisor.ts`

Purpose:

* decide when validation should run

Rules:

* after any mutation to config/build/runtime entrypoint → full validation
* after source-only targeted edit → light validation
* after documentation-only edits → no validation
* after multi-edit or scaffold creation → full validation
* after dependency changes → full validation

This module recommends timing only.
Actual validation still runs through existing validator wiring.

## 6.6 `RecoveryAdvisor.ts`

Purpose:

* help RecoveryManager choose the cleanest restart strategy

Rules:

* repeated rereads of same file → suggest targeted-read reset
* repeated narration with no progress → suggest silent hardening
* missing next step after successful tool → suggest rebuild from ledger
* invalid write attempt on existing artifact → suggest edit redirect path
* budget exhaustion without mutation → suggest block/replan

This is advisory input to RecoveryManager, not a replacement.

## 7. Main facade

## `IntelligentLayer.ts`

This should be the only module called by the rest of the runtime.

Suggested public methods:

```ts
class IntelligentLayer {
  classifyTask(context: IntelligentContext): TaskTemplate;
  adviseNextTool(context: IntelligentContext): NextToolAdvice;
  chooseReadStrategy(context: IntelligentContext): ReadStrategyDecision;
  adviseBatching(context: IntelligentContext): BatchDecision;
  adviseValidation(context: IntelligentContext): ValidationDecision;
  adviseRecovery(context: IntelligentContext): RecoveryDecision;
}
```

Keep it stateless where possible.

## 8. Where to integrate it

## 8.1 At run initialization

Call:

* `classifyTask()`

Write result into execution state:

* `taskTemplate`

Do this once unless recovery explicitly rebuilds classification.

## 8.2 Before tool recommendation prompt assembly

Call:

* `adviseNextTool()`
* `chooseReadStrategy()`

Inject only a **compact structured hint** into code-mode prompt, for example:

```ts
intelligentHint = {
  recommendedTool: "grep_content",
  readStrategy: "grep_first",
  shouldBatch: false,
  shouldValidateAfter: false
};
```

Do not inject explanations longer than a few lines.

## 8.3 Before first write in code mode

Call:

* `adviseBatching()`

If batch required, framework must enforce existing batch logic.
Advisor only helps decide early.

## 8.4 After successful mutation

Call:

* `adviseValidation()`

Then hand off to existing validation flow.

## 8.5 On recovery trigger

Call:

* `adviseRecovery()`

Then RecoveryManager decides actual action.

## 9. Prompt integration rules

If you inject intelligent hints into prompt assembly:

* do it only in code mode
* keep it under a very small size
* inject as structured note, not prose essay
* never include historical narrative
* never include internal debug logs
* never include duplicated tool descriptions

Example allowed prompt note:

```text
[Intelligent Hint]
taskTemplate=greenfield_scaffold
recommendedDiscovery=grep_first
recommendedNextTool=glob_files
shouldBatch=true
```

That is enough.

## 10. Feature flags

Add settings:

* `intelligentLayer.enabled`
* `intelligentLayer.promptHintsEnabled`
* `intelligentLayer.recoveryHintsEnabled`

Recommended defaults:

* enabled: `true` after tests pass
* promptHintsEnabled: `true`
* recoveryHintsEnabled: `true`

If you want a safer rollout:

* start all as `false`
* enable in staged testing

## 11. Guardrails

The intelligent layer must never:

* override dispatcher permission checks
* override mode restrictions
* bypass `.bormagi` access rules
* bypass artifact-aware write/edit routing
* increase discovery budget
* suppress validator failures
* create extra provider calls in v1
* store hidden state outside execution state

## 12. Logging and observability

Add one compact log entry per advisory decision.

Examples:

* `task_template_classified`
* `tool_advice_generated`
* `read_strategy_selected`
* `batch_advice_generated`
* `validation_advice_generated`
* `recovery_advice_generated`

Each log should include:

* run id
* phase
* template
* recommendation
* confidence
* reason code

Do not log verbose prose.

## 13. Testing requirements

Create tests for each module.

## 13.1 Task classifier tests

Cases:

* document_then_wait
* greenfield scaffold
* existing project patch
* investigate then report
* plan only
* ambiguous prompt fallback behavior

## 13.2 Tool selection tests

Cases:

* empty workspace
* exact file known
* large file known
* symbol-based patch in TS file
* existing artifact write redirect recommendation
* post-mutation validation recommendation

## 13.3 Read strategy tests

Cases:

* unknown file
* large file
* symbol known
* config file
* markdown doc

## 13.4 Batch strategy tests

Cases:

* single-file edit
* scaffold
* multi-file refactor
* unstable discovery state

## 13.5 Validation advisor tests

Cases:

* package.json modified
* tsconfig modified
* source file modified
* docs only modified
* multi-edit modified

## 13.6 Recovery advisor tests

Cases:

* repeated rereads
* missing next step
* repeated continue without progress
* protocol contamination detected

## 14. Rollout order

Implement in this order:

1. `types.ts`
2. `TaskTemplateClassifier.ts`
3. `ReadStrategyAdvisor.ts`
4. `ToolSelectionAdvisor.ts`
5. `BatchStrategyAdvisor.ts`
6. `ValidationAdvisor.ts`
7. `RecoveryAdvisor.ts`
8. `IntelligentLayer.ts`
9. integrate at run start
10. integrate before prompt assembly
11. integrate after mutation
12. integrate into recovery path
13. add logs
14. add tests
15. enable behind flags
16. run live sessions
17. enable by default only after verification

## 15. Success criteria

The intelligent layer is acceptable only if live sessions show these improvements:

* fewer whole-file reads
* earlier use of grep/targeted tools
* fewer repeated “continue” prompts
* fewer narration-only turns
* faster convergence to first useful write
* validation runs at the right moments
* no regression in existing control-model behavior

## 16. What not to do in this phase

Do not:

* add an LLM-based planner
* redesign execution state again
* replace RecoveryManager
* replace DiscoveryBudget
* replace PromptAssembler
* add another large prompt file
* create a second “agent brain”

## 17. Final instruction to the team

Build the intelligent layer as a **small deterministic advisory subsystem**.

Its purpose is:

* improve decision quality
* reduce drift
* reduce wasted reads
* improve first-step selection

Its purpose is not:

* to control execution
* to reinterpret the task every turn
* to add complexity for its own sake

If implemented correctly, it should feel like a **light guidance layer on top of a now-stable execution engine**, not a new architecture.
