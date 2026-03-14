# Agent Productivity Fixes — Phased Implementation Plan

**Source documents:**
- `00-fixing_agent_productivity.md` — 15-point rollout strategy (single `executionEngineV2` flag, test then flip)
- `00-fixing-agent_productivity_detailed_desgin.md` — 10-phase developer-ready backlog (Phases 0–10)

**Approach:** The strategy doc constrains scope (one flag, no flag proliferation, live verification before default flip). The detailed design provides the implementation target. Fix confirmed runtime gaps first; borrow the detailed design's structure only where it directly resolves those gaps. Do not over-engineer.

**Key decisions (from open-questions.md PQ-1 through PQ-10):**
- Plan = covers remaining gaps only; completed items listed as baseline (PQ-1 corrected, PQ-2: A)
- AgentRunner = incremental extraction, not full split (PQ-3: C)
- StepContract = internal framework concept, infer from tool_use (PQ-4: B)
- FSM = keep runPhase + add executionPhase sub-state (PQ-5: B)
- Symbol tools = regex sufficient, Phase 6 complete (PQ-6: A)
- TaskClassifier = rule/keyword-based only (PQ-7: A)
- Silent mode = strip narration silently (PQ-8: A)
- V2 default = do not flip until live session passes (PQ-9: B)
- Dispatcher = block mutation tools in ask/plan modes (PQ-10: A)

---

## Mapping: Source Document Phases → Implementation Status

| Phase (detailed_design.md) | Goal | Status | Plan section |
|---|---|---|---|
| Phase 0 — Stabilize | Reformat files, add startup logging, remove "currently editing", descriptive workspace summary | Partially done (0.3 confirmed absent, 0.4 exists; 0.1 reformatting not needed — files are normal TS; 0.2 logging missing) | Plan Phase 0 |
| Phase 1 — ExecutionKernel | FSM, StepContract, ExecutionLedger, split AgentRunner | Not done | Plan Phases 1, 2, 3 |
| Phase 2 — Transcript-free | PromptAssembler as only code-mode path, stop persisting raw tool results | Partially wired in V2 path; isolation gaps confirmed in logs | Plan Phase 2 |
| Phase 3 — Resume/recovery | nextToolCall authoritative, MilestoneFinalizer, RecoveryController, pause/completion UX | nextToolCall field exists; RecoveryManager exists; MilestoneFinalizer and ResumeController not extracted | Plan Phases 3, 4 |
| Phase 4 — DiscoveryBudget | Budget categories, route decisions, ToolDispatcher delegates | **Done** | Baseline |
| Phase 5 — Navigation tools | glob, grep, read_range, read_head, read_tail, read_match_context | **Done** | Baseline |
| Phase 6 — Symbol tools | find/read/replace/insert symbol | **Done** (regex approach per PQ-6) | Baseline |
| Phase 7 — Validation gate | ConsistencyValidator wired to write lifecycle, severity model | ConsistencyValidator exists with severity; not wired to hot path | Plan Phase 7 |
| Phase 8 — Task templates + skills | TaskTemplate, TaskClassifier, skill playbooks | Skills done; TaskTemplate/Classifier not done | Plan Phase 8 (8.2 baseline) |
| Phase 9 — Mode permissions + silent | Dispatcher blocks mutations in read-only modes, strict silent | ContextEnvelope blocks editable files; dispatcher enforcement missing | Plan Phase 6 + 5 |
| Phase 10 — Default flip + cleanup | Flip executionEngineV2 default, remove V1, fix metadata | Not done (live verification required first) | Plan Phase 9 + 10 |

---

## Baseline Already Implemented

These items are complete and are not re-planned below:

| Item | File | Status |
|------|------|--------|
| Navigation tools (glob, grep, read_range, read_head, read_tail, read_match_context) | `src/mcp/builtin/code-nav-server.ts` | Done |
| Symbol tools (find_symbols, read/replace/insert symbol block) — regex approach | `src/mcp/builtin/code-nav-server.ts` | Done |
| Skill playbooks (4 `.md` files + skillLoader.ts) | `src/skills/` | Done |
| DiscoveryBudget.ts (7 budget categories, routing suggestions) | `src/agents/execution/DiscoveryBudget.ts` | Done |
| ConsistencyValidator.ts (info/warning/critical severity, 5 checks) | `src/agents/execution/ConsistencyValidator.ts` | Done |
| RecoveryManager.ts (5 triggers, rebuild from executedTools) | `src/agents/execution/RecoveryManager.ts` | Done |
| PromptAssembler.ts (compact code-mode messages, activeSkills injection) | `src/agents/execution/PromptAssembler.ts` | Done |
| nextToolCall field + runPhase/SessionPhase in ExecutionStateManager | `src/agents/ExecutionStateManager.ts` | Done |
| TranscriptSanitiser.ts | `src/agents/execution/TranscriptSanitiser.ts` | Done |
| executionEngineV2 feature flag | `package.json` + `AgentRunner.ts` | Done (default false) |
| BatchEnforcer + ArchitectureLock | `src/agents/execution/` | Done |
| External messages in data/execution-messages.json | `data/execution-messages.json` | Done |
| Approval gating, .bormagi path blocking, reread prevention | `ToolDispatcher.ts` | Done |

---

## Phase 0 — Confirm Baseline Is Actually Wired

**Goal:** Verify the implemented features are active in the V2 runtime path. Log analysis shows some guards exist as code but are not enforced at runtime.

**Risk:** Low — read-only verification + minor wiring fixes only.

### 0.1 Add active-path startup logging

**File:** `src/agents/AgentRunner.ts`

Log once per run in `run()` before the main loop:

```typescript
onThought?.(`[Runtime] engine=V${useV2 ? 2 : 1} | silent=${state.silentExecution ?? false} | mode=${resolvedMode} | phase=${execState?.runPhase ?? 'NEW'}`);
```

Also log: prompt builder used, recovery enabled, task template (when Phase 8 lands).

**Acceptance:** Every session log clearly shows which path is active.

### 0.2 Verify V2 path is entered correctly

**File:** `src/agents/AgentRunner.ts`

Check that `useV2` is evaluated once at the top of `run()` and all downstream branches use the same value. Confirm the configuration key matches `package.json` default.

**File:** `package.json`

Confirm `"bormagi.executionEngineV2"` default is `false` (intentional until Phase 9).

### 0.3 Confirm "currently editing" is absent

**File:** `src/agents/PromptComposer.ts`, `src/context/prompts/modes/code.md`, any system prompt template

Run grep: `grep -r "currently editing" src/`. The test at `src/tests/execution/prompt-assembly.test.ts:117` already asserts this is not present. Confirm the production code has no such injection.

**Acceptance:** No grep match in production source.

### 0.4 Confirm workspace summary has no imperative language

**File:** `src/agents/execution/PromptAssembler.ts` — `buildWorkspaceSummary()`

Ensure the function never outputs text like "Start by creating..." or "You should first...". It must describe facts only: workspace type, key files, scaffold present/absent.

**Acceptance criterion:** Workspace summary block contains only descriptive facts.

---

## Phase 1 — Fix Execution State as True Authority

**Goal:** Fix the confirmed log failure "Iterations used so far: 0 even after multiple tool calls". State must update after every successful tool, not just at session end.

**Risk:** Medium — touches the hot path but changes are additive.

### 1.1 Verify state mutation after each tool (not just session end)

**File:** `src/agents/AgentRunner.ts` (V2 path)

In the tool-result handling branch (after successful dispatch), confirm these calls happen:
- `stateManager.markToolExecuted(state, toolName, ...)`
- `stateManager.markFileRead(state, path)` / `markFileWritten(state, path)` as appropriate
- Atomic `stateManager.save()` call

If any of these are deferred to end-of-run, move them to the per-iteration point.

**Root cause from logs:** The log showed `iterationsUsed: 0` throughout a session with 6+ tool calls, meaning these mutations were either not firing or not being persisted. Fix: ensure `iterationsUsed` increments and is saved after every successful tool result.

**Acceptance criterion:** After each tool call, the `.bormagi/execution-state.json` shows updated `iterationsUsed`, `executedTools`, `lastExecutedTool`.

### 1.2 Add `executionPhase` sub-state field

**File:** `src/agents/ExecutionStateManager.ts`

Add to `ExecutionStateData`:
```typescript
executionPhase?: ExecutionSubPhase; // transient — not persisted across restarts
```

New type in `src/agents/execution/ExecutionPhase.ts`:
```typescript
export type ExecutionSubPhase =
  | 'INITIALISING'
  | 'DISCOVERING'
  | 'PLANNING_BATCH'
  | 'EXECUTING_STEP'
  | 'VALIDATING_STEP'
  | 'RECOVERING';
```

Add to `ExecutionStateManager`:
```typescript
setExecutionPhase(state: ExecutionStateData, phase: ExecutionSubPhase): void
getExecutionPhase(state: ExecutionStateData): ExecutionSubPhase
```

This field is transient (in-memory only, not persisted). The existing `runPhase`/`SessionPhase` remains for terminal/persistent states. This field provides observability into what the agent is doing within a run.

**Wire into AgentRunner (V2 path):** Set phase transitions at:
- Run start → `INITIALISING`
- First discovery tool (read/glob/grep) → `DISCOVERING`
- `declare_file_batch` tool call → `PLANNING_BATCH`
- write/edit tool call → `EXECUTING_STEP`
- After write → ConsistencyValidator runs → `VALIDATING_STEP`
- RecoveryManager fires → `RECOVERING`

**Acceptance criterion:** `onThought` shows current sub-phase transitions during a run.

### 1.3 Fix speculative action filtering

**File:** `src/agents/AgentRunner.ts`

**Root cause from logs:** Assistant text like `[write_file: src/index.ts (133 chars)]` was persisted as completed work even though the actual tool was not called. This caused the next session to start with a fabricated artifact.

Add a filter immediately before any state mutation triggered by assistant text events:

```typescript
function looksLikeToolSyntax(text: string): boolean {
  return /\[(write_file|edit_file|read_file|list_files|run_command):/i.test(text)
      || /^TOOL:/m.test(text)
      || /<tool_result/i.test(text);
}
```

Rule: if `event.type === 'text'` and `looksLikeToolSyntax(event.delta)`:
- Do NOT update execution state from this text
- Do NOT add this to `completedSteps` or `nextActions`
- Still show to user (or strip per silent mode setting)

Only actual `tool_result` events from the provider stream may update execution state.

**Acceptance criterion:** A session that ends with assistant text "About to write src/index.ts" does NOT cause the next resume to show that file as written in the artifact registry.

### 1.4 Add `ExecutionSubPhase` to startup log

**File:** `src/agents/AgentRunner.ts`

Extend the startup log from Phase 0.1 to include the initial executionPhase value.

---

## Phase 2 — StepContract: Internal Classification of LLM Output

**Goal:** Every LLM response cycle produces a classified outcome. No "mystery text" in the execution flow. Implements PQ-4 (Option B: infer from tool_use internally).

**Risk:** Low — additive wrapper, no provider changes.

### 2.1 Create StepContract type

**New file:** `src/agents/execution/StepContract.ts`

```typescript
export type StepContractKind = 'tool' | 'pause' | 'complete' | 'blocked';

export interface StepContract {
  kind: StepContractKind;
  // kind=tool:
  toolName?: string;
  toolInput?: Record<string, unknown>;
  reason?: string;
  // kind=pause:
  pauseMessage?: string;
  // kind=complete:
  completionMessage?: string;
  // kind=blocked:
  blockedReason?: string;
  recoverable?: boolean;
}
```

### 2.2 Wire contract inference in AgentRunner (V2 path)

**File:** `src/agents/AgentRunner.ts`

After each LLM response cycle, classify the outcome:

```typescript
function inferStepContract(
  toolCalls: ToolCall[],
  assistantText: string,
  isSilentMode: boolean,
  runPhase: SessionPhase,
): StepContract {
  // tool call present → always tool contract
  if (toolCalls.length > 0) {
    return { kind: 'tool', toolName: toolCalls[0].name, toolInput: toolCalls[0].input };
  }
  // text only — classify by terminal signals
  if (runPhase === 'WAITING_FOR_USER_INPUT') {
    return { kind: 'pause', pauseMessage: assistantText };
  }
  if (runPhase === 'COMPLETED') {
    return { kind: 'complete', completionMessage: assistantText };
  }
  if (runPhase === 'BLOCKED_BY_VALIDATION' || runPhase === 'RECOVERY_REQUIRED') {
    return { kind: 'blocked', blockedReason: assistantText, recoverable: runPhase !== 'RECOVERY_REQUIRED' };
  }
  // fallback: treat text-only as pause (agent is asking for input)
  return { kind: 'pause', pauseMessage: assistantText };
}
```

Use the contract to drive the iteration loop decision: `continue | stop | recover`.

### 2.3 Strengthen PromptAssembler sanitizer assertion

**File:** `src/agents/execution/PromptAssembler.ts`

Before returning the assembled messages, validate:
```typescript
const PROTOCOL_LEAK_PATTERNS = [
  /<tool_result/i,
  /\[write_file:/i,
  /^TOOL:/m,
  /\[ASSISTANT\]/,
];

function assertNoProtocolLeak(messages: ChatMessage[]): void {
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    for (const p of PROTOCOL_LEAK_PATTERNS) {
      if (p.test(content)) {
        throw new Error(`[PromptAssembler] Protocol leak detected in ${msg.role} message: pattern ${p}`);
      }
    }
  }
}
```

In dev/test mode throw; in production log a warning and strip the offending message.

**Acceptance criterion:** Code-mode prompts containing `<tool_result` cause an assertion in tests.

### 2.4 Add prompt-size regression test

**New file (or extend existing):** `src/tests/execution/prompt-assembly.test.ts`

Add test: assemble messages for a scenario with 10 prior tool calls. Verify total character count is less than 4,000 (no history replay).

---

## Phase 3 — Fix continue/resume

**Goal:** Fix the confirmed log failure "model rereads files on continue even though they are in files_read". Fix: continue dispatches `nextToolCall` directly.

**Risk:** Medium — touches the main loop entry point.

### 3.1 Extract ResumeController

**New file:** `src/agents/execution/ResumeController.ts`

```typescript
export class ResumeController {
  constructor(
    private stateManager: ExecutionStateManager,
    private toolDispatcher: ToolDispatcher,
    private messages: ExecutionMessages,
  ) {}

  isResumeMessage(userMessage: string): boolean;
  // Returns true for: "continue", "continiue", "proceed", "resume", "go on", "next"

  async resume(
    state: ExecutionStateData,
    onText: (t: string) => void,
    onThought: (t: string) => void,
  ): Promise<ResumeOutcome>;
}

export type ResumeOutcome =
  | { kind: 'dispatched'; toolName: string }
  | { kind: 'needs-llm'; prompt: string }
  | { kind: 'recovery-required'; reason: string };
```

**Logic:**
```
if state.nextToolCall is valid AND tool is in allowed list:
  emit brief summary: msgs.continueResume.summary
  dispatch nextToolCall directly (no LLM call)
  clear nextToolCall from state
  return { kind: 'dispatched' }

else if state.nextAction is non-empty:
  emit brief summary: msgs.continueResume.summaryWithLast
  build compact prompt: system + state summary + "continue from: {nextAction}"
  return { kind: 'needs-llm', prompt }

else:
  emit: msgs.continueResume.missingNextAction
  return { kind: 'recovery-required', reason: 'no nextAction' }
```

**File:** `src/agents/AgentRunner.ts`

Wire `ResumeController` at the start of `run()`: if `isResumeMessage(userMessage)`, delegate to `resume()` before entering the main loop.

### 3.2 Enforce already-read files on resume

**File:** `src/agents/execution/ToolDispatcher.ts`

When `V2 + continue path`: on `read_file` or `read_file_range` calls, check `state.resolvedInputs` (files already read). If the path is present AND file has not been written since last read, block with:
```
msgs.toolBlocked.reread
```

This check already exists for same-run rereads. Ensure it also activates at resume start by loading the persisted state into the guard at the top of a resumed run.

**Acceptance criterion:** After "continue", a `read_file` for a file in `resolvedInputs` returns the blocked message, not the file content.

### 3.3 Regression tests

**File:** `src/tests/execution/resume.test.ts` (extend or create)

Tests:
- `nextToolCall` present → dispatched directly, no provider call made
- `nextAction` present, no `nextToolCall` → compact LLM prompt built
- Both absent → `recovery-required` outcome
- On resume, `read_file` for file in `resolvedInputs` is blocked

---

## Phase 4 — MilestoneFinalizer

**Goal:** Every step ends with a deterministic continue/wait/validate/complete decision. No silent stops. Implements PQ-3 (incremental extraction).

**Risk:** Medium — new module, wired into AgentRunner.

### 4.1 Create MilestoneFinalizer

**New file:** `src/agents/execution/MilestoneFinalizer.ts`

```typescript
export type MilestoneDecision =
  | { action: 'CONTINUE' }
  | { action: 'VALIDATE'; reason: string }
  | { action: 'WAIT'; message: string }
  | { action: 'COMPLETE'; message: string }
  | { action: 'BLOCK'; reason: string; recoverable: boolean };

export class MilestoneFinalizer {
  decide(
    state: ExecutionStateData,
    stepContract: StepContract,
    lastToolName: string,
    lastToolPath?: string,
    objectiveKeywords: string[],
  ): MilestoneDecision;
}
```

**Rules (in priority order):**

1. If `stepContract.kind === 'pause'` or `runPhase === 'WAITING_FOR_USER_INPUT'` → `WAIT`
2. If `stepContract.kind === 'complete'` or `runPhase === 'COMPLETED'` → `COMPLETE`
3. If `stepContract.kind === 'blocked'` → `BLOCK`
4. If `lastToolName` is a write/edit tool AND batch has been declared AND all batch files completed → `VALIDATE` then `COMPLETE`
5. If `lastToolName` is a write/edit tool AND consecutive write count reaches batch checkpoint → `VALIDATE`
6. If `lastToolName` is a write/edit tool AND last written file name matches wait-keywords (`open_questions`, `questions`, `plan`, `review`) AND objective contains "wait" or "document" → `WAIT` with auto-message
7. If `runPhase === 'RECOVERY_REQUIRED'` → `BLOCK(recoverable=false)`
8. Default → `CONTINUE`

**File:** `src/agents/AgentRunner.ts`

After each tool execution in the V2 loop:
```typescript
const decision = milestoneFinalizer.decide(state, stepContract, lastToolName, lastToolPath, objectiveWords);
switch (decision.action) {
  case 'WAIT':
    stateManager.setSessionPhase(state, 'WAITING_FOR_USER_INPUT', decision.message);
    onText(msgs.terminalStates.waitingForUserInput.replace('{reason}', decision.message));
    return; // exit run loop
  case 'COMPLETE':
    stateManager.setSessionPhase(state, 'COMPLETED');
    onText(msgs.terminalStates.sessionCompleted);
    return;
  case 'BLOCK':
    stateManager.setSessionPhase(state, decision.recoverable ? 'BLOCKED_BY_VALIDATION' : 'RECOVERY_REQUIRED');
    onText(msgs.terminalStates.blockedByValidation);
    return;
  case 'VALIDATE':
    // proceed to Phase 7 validator integration
    break;
  case 'CONTINUE':
    break;
}
```

### 4.2 Externalise all milestone messages

**File:** `data/execution-messages.json`

Add keys (if not already present):
```json
{
  "milestoneDecisions": {
    "waitAutoDetected": "Deliverable written — pausing for your input.",
    "batchCheckpoint": "Batch checkpoint reached — running validation."
  }
}
```

### 4.3 Regression tests

**New file:** `src/tests/execution/milestone-finalizer.test.ts`

Tests:
- Write to `open_questions.md` with "wait" in objective → `WAIT`
- `stepContract.kind === 'complete'` → `COMPLETE`
- All batch files written → `VALIDATE`
- `RECOVERY_REQUIRED` phase → `BLOCK(recoverable=false)`
- Normal write → `CONTINUE`

---

## Phase 5 — Silent Execution Enforcement

**Goal:** When `silentExecution=true`, pre-tool narration is stripped silently. Implements PQ-8 (Option A).

**Risk:** Low — modifies output filtering, not tool dispatch.

### 5.1 Strip narration in silent mode

**File:** `src/agents/AgentRunner.ts` (V2 path, stream processing)

In the stream event loop, when processing `type === 'text'` events and `state.silentExecution === true`:
- Do NOT pass through `onText()` (do not show to user)
- Do NOT count as an iteration
- Still accumulate to check for protocol-leak patterns (Phase 1.3)

Only emit tool calls and completion summaries via `onText()`.

### 5.2 Single reprompt if no tool call in silent mode

**File:** `src/agents/AgentRunner.ts`

If a full LLM cycle in silent mode produces only text (no tool call) AND `StepContract.kind !== 'pause' | 'complete' | 'blocked'`:
- Internally send one terse system message: `"TOOL ONLY — call the next tool immediately, no text"`
- Increment a `silentRepromptCount` counter
- If `silentRepromptCount >= 2`, treat as `StepContract.kind = 'blocked'` and stop

### 5.3 Remove narration encouragement from PromptComposer

**File:** `src/agents/PromptComposer.ts`

Remove or weaken in the code-mode section:
- "always think step-by-step before acting" → remove
- "clearly state what you intend to do and why" → remove

The code.md already has correct guidance. Ensure PromptComposer does not contradict it.

**File:** `src/context/prompts/modes/code.md`

Verify the instruction already reads: "Execute first. Narrate only in milestone summaries." If not, add it.

### 5.4 Regression tests

**File:** `src/tests/execution/silent-execution.test.ts` (create or extend)

Tests:
- In silent mode, pre-tool text events do not trigger `onText()` calls
- In silent mode, text-only response triggers one reprompt, then `blocked` after second
- Non-silent mode: text passes through normally

---

## Phase 6 — Dispatcher Hardening

**Goal:** Mutation tools are blocked in ask/plan modes at the transport layer. Discovery budget is verified to be blocking not advisory. Implements PQ-10 (Option A).

**Risk:** Low — additive guards.

### 6.1 Add mutation-tool blocking in ask/plan modes

**File:** `src/agents/execution/ToolDispatcher.ts`

At the top of `dispatch()`, after reading the current mode:

```typescript
const MUTATION_TOOLS = new Set([
  'write_file', 'edit_file', 'replace_range', 'multi_edit',
  'replace_symbol_block', 'insert_before_symbol', 'insert_after_symbol',
  'create_document', 'create_presentation',
]);

if ((g.mode === 'ask' || g.mode === 'plan') && MUTATION_TOOLS.has(toolEvent.name)) {
  return getAppData().executionMessages.toolBlocked.modeDisallowsMutation;
}
```

**File:** `data/execution-messages.json`

Add:
```json
{
  "toolBlocked": {
    "modeDisallowsMutation": "[BLOCKED] Mode '{mode}' does not permit file mutations. Switch to Code mode to make changes."
  }
}
```

### 6.2 Verify discovery budget is truly blocking

**File:** `src/agents/execution/ToolDispatcher.ts`

Confirm the budget check:
1. Is called BEFORE the MCP dispatch (not after)
2. Returns the blocked string (not undefined/null) when budget is exhausted
3. The blocked string causes the iteration to end (not continue)

Add a test if not covered:

**File:** `src/tests/tools/discovery-budget.test.ts`

Test: after 2 `read_file` calls (whole_file budget), a 3rd is blocked and the blocked string is returned.

### 6.3 Verify off-batch write blocking

**File:** `src/agents/execution/ToolDispatcher.ts` (or BatchEnforcer.ts)

Confirm that once `declare_file_batch` has been called:
- A `write_file` to a path NOT in the batch returns `msgs.toolBlocked.offBatch`
- The check happens even on resumed sessions (batch is reloaded from state)

**Acceptance criterion:** Write to off-batch path → structured blocked result.

---

## Phase 7 — Wire ConsistencyValidator into Hot Path

**Goal:** Post-write validation is automatic. Agents cannot build on a broken workspace. Implements detailed_design Phase 7.

**Risk:** Medium — ConsistencyValidator already exists; wiring is the work.

### 7.1 Wire validator after each mutating step

**File:** `src/agents/AgentRunner.ts` (V2 path)

After each successful `write_file` / `edit_file` / `multi_edit` / symbol edit tool:

```typescript
if (useV2 && MUTATION_TOOLS.has(lastToolName)) {
  setExecutionPhase(state, 'VALIDATING_STEP');
  const issues = await consistencyValidator.validate(
    Array.from(filesWrittenThisRun),
    execState,
    architectureLock,
  );
  const criticals = issues.filter(i => i.severity === 'critical');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (warnings.length > 0) {
    onThought?.(`[Validator] ${warnings.length} warning(s): ${warnings.map(w => w.issue).join('; ')}`);
  }

  if (criticals.length > 0) {
    onText(msgs.terminalStates.blockedByValidation);
    stateManager.setSessionPhase(execState, 'BLOCKED_BY_VALIDATION');
    criticals.forEach(c => onThought?.(`[Validator CRITICAL] ${c.path}: ${c.issue}`));
    break; // exit run loop
  }

  setExecutionPhase(state, 'EXECUTING_STEP'); // restore phase after clean validation
}
```

### 7.2 Persist validation result in state

**File:** `src/agents/ExecutionStateManager.ts`

Add to `ExecutionStateData`:
```typescript
lastValidationResult?: {
  at: string;          // ISO timestamp
  checkedFiles: string[];
  criticalCount: number;
  warningCount: number;
  passed: boolean;
};
```

Persist after each validation run.

### 7.3 Feature flag gate

Keep validator wired behind `validatorEnforcement` config flag (already exists). Default: `false`. Flip after Phase 8 regression tests confirm no false-positive criticals.

### 7.4 Regression tests

Extend `src/tests/execution/consistency-validator.test.ts`:

- `.ts` file written without `package.json` → critical issue → run loop blocks
- All batch files written → no critical issues → run continues
- Warning issued but not blocking

---

## Phase 8 — Task Templates and Classifier

**Goal:** Classify task shape once at start of run. Use template to drive stop rules, batch requirements, workspace summary style. Implements detailed_design Phase 8.

**Risk:** Low — additive, does not change existing flow.

### 8.1 Create TaskTemplate

**New file:** `src/agents/execution/TaskTemplate.ts`

```typescript
export type TaskTemplateName =
  | 'document_then_wait'
  | 'greenfield_scaffold'
  | 'existing_project_patch'
  | 'multi_file_refactor'
  | 'investigate_then_report'
  | 'plan_only';

export interface TaskTemplate {
  name: TaskTemplateName;
  requiresBatch: boolean;          // Must declare file batch before writing
  allowDiscovery: boolean;         // May use discovery tools
  maxWholeFileReads?: number;      // Override default budget
  stopAfterWrite?: boolean;        // Wait after first write milestone (document_then_wait)
  stopRules: string[];             // Human-readable stop rules for startup log
}

export const TASK_TEMPLATES: Record<TaskTemplateName, TaskTemplate> = {
  document_then_wait: {
    name: 'document_then_wait',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Stop after writing deliverable document and wait for user response'],
  },
  greenfield_scaffold: {
    name: 'greenfield_scaffold',
    requiresBatch: true,
    allowDiscovery: true,
    stopRules: ['Declare batch before first write', 'Lock architecture before scaffold'],
  },
  existing_project_patch: {
    name: 'existing_project_patch',
    requiresBatch: false,
    allowDiscovery: true,
    stopRules: ['Fix targeted files only', 'Validate after each write'],
  },
  multi_file_refactor: {
    name: 'multi_file_refactor',
    requiresBatch: true,
    allowDiscovery: true,
    stopRules: ['Declare all affected files in batch', 'Validate after batch completion'],
  },
  investigate_then_report: {
    name: 'investigate_then_report',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Investigate codebase', 'Write report file', 'Stop and wait'],
  },
  plan_only: {
    name: 'plan_only',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Write plan document only', 'Do not implement code'],
  },
};
```

### 8.2 Create TaskClassifier (rule-based)

**New file:** `src/agents/execution/TaskClassifier.ts`

```typescript
export function classifyTask(userMessage: string, mode: AssistantMode): TaskTemplateName {
  const text = userMessage.toLowerCase();

  // plan mode always → plan_only
  if (mode === 'plan') return 'plan_only';

  // document_then_wait signals
  if (/\b(write|create|produce)\b.*(question|doc|document|summary).*\b(wait|stop|pause|review)\b/i.test(text)) {
    return 'document_then_wait';
  }

  // greenfield signals
  if (/\b(scaffold|bootstrap|create\s+project|start\s+from\s+scratch|new\s+(project|app|application|service))\b/i.test(text)) {
    return 'greenfield_scaffold';
  }

  // multi-file refactor
  if (/\b(refactor|rename|move|reorganise|reorganize)\b.*(across|all|multiple|every)\b/i.test(text)) {
    return 'multi_file_refactor';
  }

  // investigate/report
  if (/\b(analyse|analyze|investigate|review|audit|what is wrong|find out|diagnose)\b/i.test(text)
    && !/\b(fix|write|create|implement)\b/i.test(text)) {
    return 'investigate_then_report';
  }

  // plan_only explicit
  if (/\b(plan only|do not implement|design only|no code)\b/i.test(text)) {
    return 'plan_only';
  }

  // default: existing project patch
  return 'existing_project_patch';
}
```

### 8.3 Wire TaskClassifier into AgentRunner

**File:** `src/agents/AgentRunner.ts`

At the start of `run()` (after mode classification):
```typescript
const taskTemplate = classifyTask(userMessage, resolvedMode);
execState.taskTemplate = taskTemplate;
stateManager.save(execState);

onThought?.(`[TaskTemplate] ${taskTemplate} | stopAfterWrite=${TASK_TEMPLATES[taskTemplate].stopAfterWrite ?? false}`);
```

Pass `taskTemplate` to `MilestoneFinalizer.decide()` so stop rules can be template-aware.

**File:** `src/agents/ExecutionStateManager.ts`

Add:
```typescript
taskTemplate?: TaskTemplateName; // Set at run start
```

### 8.4 Skill auto-loading based on template

**File:** `src/agents/AgentRunner.ts`

When building PromptContext, add `activeSkills` based on template:

```typescript
const templateSkillMap: Partial<Record<TaskTemplateName, SkillName[]>> = {
  greenfield_scaffold: ['implement-feature'],
  existing_project_patch: ['codebase-navigator', 'implement-feature'],
  multi_file_refactor: ['codebase-navigator'],
  investigate_then_report: ['bug-investigator', 'codebase-navigator'],
};
const activeSkills = templateSkillMap[taskTemplate] ?? [];
```

### 8.5 Regression tests

**New file:** `src/tests/execution/task-classifier.test.ts`

Tests: one test per template for keyword matching, default fallback, plan mode override.

---

## Phase 9 — executionEngineV2 Activation

**Goal:** Run all regression tests with V2 forced. Document live session verification plan. Do NOT flip default until live sessions pass. Implements PQ-9 (Option B).

**Risk:** Medium — test run only, no code changes; default flip deferred.

### 9.1 Run regression suite with V2 forced

**Action:** In `jest.config.js` test setup or via `__setConfig`, set `executionEngineV2: true` for all tests.

**Target:** All 615+ tests pass.

### 9.2 Live session verification plan

Document in `docs/New-Requirements/v2-live-verification.md` three required scenarios to pass before flipping the default:

1. **Greenfield scenario:** New empty workspace, ask agent to scaffold a simple Express app.
   - Verify: no `.bormagi/` access in tool log, discovery budget blocks on attempt 4+, batch declared before first write, tool results never appear as user messages.

2. **Continue/resume scenario:** Start a task, run 3–4 steps, send "continue".
   - Verify: brief resume summary shown, execution picks up from `nextToolCall` (no provider call), no full history replay.

3. **Wait-state scenario:** Ask agent to write `open_questions.md` and wait for answers.
   - Verify: agent stops cleanly after writing the file (not continuing to explore `.bormagi/`).

### 9.3 Flip default (deferred — after live verification passes)

**File:** `package.json`
```json
"bormagi.executionEngineV2": {
  "type": "boolean",
  "default": true,
  ...
}
```

**Only proceed after:** all 3 live scenarios pass without manual intervention.

### 9.4 V1 branch removal (after flip, separate task)

**File:** `src/agents/AgentRunner.ts`

Remove all `if (!useV2) { ... }` branches. Remove `executionEngineV2` config read. Make V2 the only path.

**Condition:** At least one stable release with V2 default before removing V1 safety net.

---

## Phase 10 — Cleanup and Metadata

**Goal:** Clean compile, no dead references, correct metadata.

**Risk:** Low.

### 10.1 Add lint/format guard in CI

**File:** `.github/workflows/ci.yml`

Confirm `eslint` + `tsc --noEmit` run on every PR. If not, add.

### 10.2 Fix package.json metadata

**File:** `package.json`

Update:
- `"repository.url"` — point to actual GitHub repo URL
- `"homepage"` — update
- `"bugs.url"` — update

### 10.3 Run full regression suite

All tests must pass. No new test failures introduced by Phases 0–8.

---

## Critical Files Summary

| File | Phases | Action |
|------|--------|--------|
| `src/agents/AgentRunner.ts` | 0, 1, 2, 3, 4, 5, 6, 7, 8 | Wire all new modules; fix state mutations; add logging |
| `src/agents/ExecutionStateManager.ts` | 1, 7, 8 | Add executionPhase, lastValidationResult, taskTemplate fields |
| `src/agents/execution/ExecutionPhase.ts` | 1 | New: ExecutionSubPhase type |
| `src/agents/execution/StepContract.ts` | 2 | New: StepContract type + inferStepContract() |
| `src/agents/execution/ResumeController.ts` | 3 | New: extracted resume logic |
| `src/agents/execution/MilestoneFinalizer.ts` | 4 | New: step outcome decider |
| `src/agents/execution/PromptAssembler.ts` | 2 | Add protocol-leak assertion |
| `src/agents/execution/ToolDispatcher.ts` | 6 | Add mutation-tool blocking in ask/plan; verify budget is hard-blocking |
| `src/agents/execution/TaskTemplate.ts` | 8 | New: task template definitions |
| `src/agents/execution/TaskClassifier.ts` | 8 | New: rule-based task classifier |
| `src/agents/PromptComposer.ts` | 5 | Remove narration-encouraging text |
| `src/context/prompts/modes/code.md` | 5 | Verify "execute first" instruction present |
| `data/execution-messages.json` | 4, 6 | Add milestoneDecisions + toolBlocked.modeDisallowsMutation |

---

## New Test Files

| File | Phase | Coverage |
|------|-------|----------|
| `src/tests/execution/resume.test.ts` | 3 | nextToolCall dispatch, reread blocking on resume |
| `src/tests/execution/milestone-finalizer.test.ts` | 4 | All 6 MilestoneDecision outcomes |
| `src/tests/execution/silent-execution.test.ts` | 5 | Narration stripping, single reprompt, blocked after 2nd |
| `src/tests/execution/task-classifier.test.ts` | 8 | 6 templates + default fallback |
| Extend `prompt-assembly.test.ts` | 2 | Protocol leak assertion, prompt-size regression |
| Extend `consistency-validator.test.ts` | 7 | Hot-path wiring, critical blocks run, warning passes |
| `docs/New-Requirements/v2-live-verification.md` | 9 | Live scenario test plan |

---

## Phase Dependency Graph

```
Phase 0 (verify baseline)
    ↓
Phase 1 (fix state authority)
    ↓
Phase 2 (StepContract)       Phase 3 (ResumeController)
    ↓                              ↓
Phase 4 (MilestoneFinalizer) ←────┘
    ↓
Phase 5 (silent exec)        Phase 6 (dispatcher hardening)
    ↓                              ↓
Phase 7 (wire ConsistencyValidator) ←─────┘
    ↓
Phase 8 (TaskTemplate + Classifier)
    ↓
Phase 9 (V2 activation + live verification)
    ↓
Phase 10 (cleanup)
```

Phases 5 and 6 are independent of each other and can run in parallel.

---

## Overall Acceptance Criteria

The implementation is "good enough" when all of these are true:

1. `iterationsUsed` increments after every successful tool call
2. No tool result appears as a `user` message in the conversation stream
3. Speculative assistant text ("about to write X") never mutates execution state
4. `continue` dispatches from `nextToolCall` without an LLM call (when available)
5. Files in `resolvedInputs` cannot be re-read unless modified since last read
6. Silent mode strips narration; agent does not produce chatter loops
7. `write_file` in ask/plan modes is blocked at the dispatcher level
8. ConsistencyValidator auto-runs after each mutating step; critical issues stop the run
9. Task template is classified and stored at run start; stop rules are template-specific
10. All 615+ regression tests pass with `executionEngineV2=true`
