
## Goal

Apply the fixes from both:

1. the **log-derived failures**
2. the **repo-derived architectural gaps**

without breaking existing functionality.

The safest approach is:

* keep the current extension activation and UI behavior intact
* keep provider/MCP integrations intact
* keep current tools intact
* refactor the execution path in place
* add guards and state around it
* only then tighten validation

---

# Merged root-cause map

## From log analysis

You need to fix:

1. execution state is injected as text, not used as live state
2. tool results are still flowing through the conversational stream
3. speculative assistant text is contaminating persisted state
4. “continue” does not resume from `nextAction`
5. narration suppression is not enforced
6. reread prevention is not enforced
7. discovery budget is advisory, not blocking
8. batch execution is not binding
9. iteration counting is not real
10. internal/control metadata can leak into normal task execution

## From repo analysis

You also need to fix:

1. `AgentRunner` still owns too much orchestration
2. `ToolDispatcher` is not yet the sole authority for tool execution
3. `ExecutionStateManager` exists but is not yet fully authoritative
4. `PromptComposer` still encourages narration in code mode
5. `ConsistencyValidator` exists but is not in the hot path
6. extension wiring, docs, and feature surface are not fully aligned
7. dependency/runtime drift may make stricter validation fail unless cleaned up

---

# Final merged implementation plan

## Phase A — make execution state authoritative

### File: `src/agents/ExecutionStateManager.ts`

### Add or extend state shape

Use one authoritative state object per running task:

```ts
export interface ExecutionTaskState {
  version: number;
  taskId: string;
  agentId: string;
  mode: 'ask' | 'plan' | 'code';

  objective: string;
  workspaceRoot: string;
  workspaceClassification: 'greenfield' | 'existing';

  iterationsUsed: number;

  filesRead: string[];
  fileReadHashes?: Record<string, string>;
  filesWritten: string[];

  executedTools: Array<{
    name: string;
    at: string;
    inputSummary?: string;
    outputSummary?: string;
  }>;

  plannedFileBatch?: {
    batchId: string;
    files: string[];
    completed: string[];
    nextIndex: number;
  };

  nextAction?: {
    type: string;
    payload?: Record<string, unknown>;
  };

  architectureLock?: {
    backendFramework?: string;
    orm?: string;
    repoShape?: string;
    frontendFramework?: string;
  };

  silentExecution?: boolean;
  recoveryMode?: boolean;

  completedSteps: string[];
  blockers: string[];
  lastValidatedAt?: string;
}
```

### Methods to add

Implement:

* `loadState(taskId: string): ExecutionTaskState | null`
* `saveState(state: ExecutionTaskState): void`
* `incrementIterations(taskId: string): number`
* `markFileRead(taskId: string, path: string, hash?: string): void`
* `markFileWritten(taskId: string, path: string): void`
* `markToolExecuted(taskId: string, toolName: string, inputSummary?: string, outputSummary?: string): void`
* `setNextAction(taskId: string, nextAction: ...)`
* `setPlannedBatch(taskId: string, batch: ...)`
* `completeBatchFile(taskId: string, path: string)`
* `canReadFile(taskId: string, path: string, currentHash?: string): boolean`

### Implementation rules

* only successful tool results may mutate state
* assistant free text may never mutate state
* persist atomically: temp file then rename
* add migration support for old versions

### Acceptance criteria

* iteration count increases after every successful tool execution
* `nextAction` survives session restart
* re-reading an unchanged file is detectable from state

---

## Phase B — make `AgentRunner` a coordinator, not the execution engine

### File: `src/agents/AgentRunner.ts`

This is the most important patch.

### Remove these behaviors from `AgentRunner`

Do not let `AgentRunner` directly:

* inject tool results as user messages
* infer completed actions from assistant text
* fabricate assistant acknowledgments
* keep transcript replay as primary state
* execute tools through custom branches if `ToolDispatcher` can do it

### Add this run flow

#### 1. Start of run

At the top of `run(...)`:

```ts
const state = executionStateManager.loadState(taskId) ?? createInitialState(...);
```

Then derive a compact execution summary:

```ts
const executionSummary = buildExecutionSummary(state);
```

This summary should include only:

* objective
* workspace classification
* already-read files
* already-written files
* current batch progress
* next action
* silent mode
* recovery mode

Not the raw prior transcript.

#### 2. Prompt assembly

Pass:

* system prompt
* compact execution summary
* current user request

Do **not** pass:

* fake assistant prefaces
* fake user tool results
* earlier repeated narration

#### 3. Tool execution

All tool calls must route through `ToolDispatcher`.

#### 4. State update

After each successful tool call:

* increment iterations
* record tool execution
* record read/write paths
* update batch completion
* update `nextAction`

#### 5. End of run

Persist:

* `lastSuccessfulTool`
* `nextAction`
* `completedSteps`
* any validator result

Do not persist “about to do X” text.

### Add hard continue semantics

When user message is:

* `continue`
* `continiue`
* `proceed`

then:

* do not replay broad context
* do not restart discovery
* load state
* resume from `nextAction` or current batch

### Add silent execution mode

If user says:

* execute immediately
* do not narrate
* call the next tool now

then:

* set `state.silentExecution = true`
* suppress assistant chatter before next tool call
* allow only tool call / final summary

### Acceptance criteria

* no tool result ever appears as a user message
* no speculative `[write_file: ...]` text enters state
* continue resumes the next action directly
* state iteration counter is real

---

## Phase C — make `ToolDispatcher` the only execution authority

### File: `src/agents/execution/ToolDispatcher.ts`

### Add dispatcher-level guards

#### 1. Reread prevention

Before `read_file`:

* compute current hash if cheap
* if file already read and unchanged, reject with structured reason

#### 2. Discovery budget enforcement

Track per run:

* `read_file` count
* `list_files` count
* consecutive discovery calls without write

If exhausted:

* reject further discovery
* allow only:

  * `write_file`
  * `edit_file`
  * `declare_batch`
  * `run_validation`

#### 3. Batch enforcement

If batch exists:

* reject writes outside batch unless an explicit `amend_batch` action happens

#### 4. Workspace/internal path filtering

Block by default:

* `.bormagi/**`
* internal state files
* hidden framework metadata

unless the framework explicitly requests them.

#### 5. Structured tool results

Return:

```ts
interface ToolExecutionResult {
  toolName: string;
  status: 'success' | 'error' | 'blocked';
  touchedPaths?: string[];
  summary: string;
  payload?: unknown;
}
```

No chat text formatting here.

### Acceptance criteria

* dispatcher can block repeated reads
* dispatcher can block off-batch writes
* dispatcher can block metadata access
* tool results are structured, not conversational

---

## Phase D — bind batching and architecture choice

### New file: `src/agents/execution/BatchPlanner.ts`

### Responsibilities

Given:

* objective
* docs already read
* workspace classification
* architecture lock

produce:

* a coherent ordered file batch
* chunk boundaries
* validator checkpoints

### Batch rules

* greenfield code mode must declare batch 1 before first write
* first batch should be small and coherent, for example:

  * `package.json`
  * `tsconfig.json`
  * `src/main.ts`
  * `src/app.module.ts`
* batch size cap: 3–5 files initially
* each batch ends with validation

### New file: `src/agents/execution/ArchitectureLock.ts`

### Responsibilities

After initial discovery, lock:

* backend framework
* ORM
* repo shape
* frontend framework
* testing/linting conventions

Example:

```ts
{
  backendFramework: 'nestjs',
  orm: 'prisma',
  repoShape: 'single-package',
  frontendFramework: 'react',
}
```

### Acceptance criteria

* no write before architecture lock in greenfield code mode
* no off-batch writes
* batch progress persists across sessions

---

## Phase E — wire validation into the hot path

### File: `src/agents/execution/ConsistencyValidator.ts`

### Add minimum checks

1. script entrypoints exist
2. imported top-level dependencies exist in `package.json`
3. tsconfig `extends` and path aliases resolve
4. declared batch files were actually written
5. architecture lock matches imports:

   * if NestJS imports appear, NestJS deps must exist
   * if Prisma schema exists, Prisma dependency must exist

### Wire points

Run validator:

* after every batch
* before session end if files were written
* after “continue” if resuming mid-batch and previous run ended unexpectedly

### Validator output

Persist in state:

* errors
* warnings
* checked files
* timestamp

### Acceptance criteria

* invalid scaffold fails fast
* state stores last validation outcome
* continue can resume after a validation failure

---

## Phase F — fix prompt contradictions

### File: `src/agents/PromptComposer.ts`

### Change code-mode instructions

Remove or weaken:

* “always think step-by-step before acting”
* “clearly state what you intend to do and why”

Replace with:

* in code mode, execute first and narrate minimally
* do not narrate planned tool calls
* do not reread unchanged files
* when resuming, continue from `nextAction`
* when `silentExecution=true`, output tool calls or final milestone summary only

### Acceptance criteria

* code mode prompt no longer encourages chatter loops
* ask/plan modes still preserve explanatory behavior

---

## Phase G — sanitize transcript and stop tool-protocol leakage

### File(s): prompt assembly / transcript compaction path

Likely in context/prompt assembly modules.

### Add sanitization

Strip from persisted conversational history:

* `[write_file: ...]`
* `TOOL:...`
* XML tool wrappers
* internal sentinels
* fake assistant bootstrap text

Only keep:

* user requests
* final assistant milestone summaries
* structured tool execution state separately

### Acceptance criteria

* transcript contains no tool protocol leakage
* state and transcript do not diverge due to synthetic text

---

## Phase H — extension-level safety tools

### File: `src/extension.ts`

Add two commands only; do not broaden feature surface yet:

1. `bormagi.showExecutionState`

   * shows compact task state for current agent/task

2. `bormagi.resetExecutionState`

   * resets persisted state for a broken task

These are debugging and recovery tools and will help you test the fixes safely.

### Acceptance criteria

* state can be inspected in VS Code
* broken loops can be reset without deleting workspace files

---

## Phase I — dependency and runtime alignment

### File: root `package.json`

### Also repo-wide import audit

Do a clean import/dependency reconciliation before turning on strict validation in CI.

### Tasks

* scan imports across `src/**`
* add missing runtime deps
* remove dead imports if modules are inactive
* add scripts:

  * `verify:imports`
  * `verify:execution`
  * `verify:state`

### Acceptance criteria

* clean checkout can install, compile, lint, and run tests
* validator is not blocked by pre-existing dependency drift

---

## Phase J — regression tests for the exact failures from the logs

### Add tests under `src/tests` or `src/agents/execution/__tests__`

Required tests:

1. tool results are not serialized as user messages
2. speculative assistant tool-like text does not mutate state
3. `iterationsUsed` increments after each tool
4. unchanged files cannot be reread when blocked
5. continue resumes from `nextAction`
6. off-batch writes are rejected
7. `.bormagi` access is blocked in normal code execution
8. validator catches missing entrypoint/dependency mismatch
9. silent execution mode suppresses assistant chatter before tool calls

### Acceptance criteria

* each previously observed failure has a direct regression test

---

# Exact acceptance milestones

## Milestone 1

`AgentRunner` + `ExecutionStateManager` + `ToolDispatcher`

* no user-channel tool results
* real iteration tracking
* continue resumes from `nextAction`

## Milestone 2

`BatchPlanner` + `ArchitectureLock`

* first scaffold batch is declared and enforced
* no freeform greenfield wandering

## Milestone 3

`ConsistencyValidator`

* batch validation is automatic and persistent

## Milestone 4

prompt and transcript cleanup

* no narration loops
* no tool protocol leakage

## Milestone 5

tests + extension debug commands

* failures are reproducible and recoverable

---

# Safe implementation order

Do it in this exact order to minimize breakage:

1. `ExecutionStateManager.ts`
2. `AgentRunner.ts`
3. `ToolDispatcher.ts`
4. transcript sanitization path
5. `PromptComposer.ts`
6. `BatchPlanner.ts`
7. `ArchitectureLock.ts`
8. `ConsistencyValidator.ts`
9. `extension.ts`
10. dependency audit
11. tests
12. README/package alignment

---

# Very important “do not break existing functionality” rules

1. Do not replace provider integration code yet
2. Do not replace MCP transport yet
3. Do not change existing tool implementations unless necessary
4. Do not widen extension UI surface while stabilizing execution
5. Keep old behavior behind feature flags until regression tests pass

Recommended feature flags:

* `executionStateV2`
* `toolResultIsolation`
* `silentExecution`
* `batchPlanner`
* `validatorEnforcement`

---

# What I recommend you implement first in code

If you want the smallest patch with the biggest payoff, start with this subset:

### Patch set 1

* `ExecutionStateManager.ts`: add real iteration/file/action tracking
* `AgentRunner.ts`: stop injecting tool results as user content
* `AgentRunner.ts`: persist only executed tool actions
* `AgentRunner.ts`: continue resumes from `nextAction`

### Patch set 2

* `ToolDispatcher.ts`: block rereads and off-batch writes
* `PromptComposer.ts`: remove code-mode narration bias

### Patch set 3

* `ConsistencyValidator.ts`: minimal checks + automatic invocation

