# Bormagi Advanced Coder — Control-Plane Fix Plan

**Date:** 2026-03-19  
**Audience:** Core runtime / controller / orchestration developers  
**Scope:** Fix premature pausing, wrong template selection, stale summaries, weak resume state, and non-deterministic continuation seen in the latest `advanced-coder` log and screen dump.

---

## 1. Executive summary

The current implementation is no longer failing because of discovery loops. It is now failing because the runtime can **perform writes** but still cannot **own the task lifecycle** reliably.

Observed symptoms from the latest run:

- The task **"start implementing the system defined in requirements.md"** starts under the wrong execution shape and still performs discovery even when `requirements.md` is already loaded and the runtime says **"Begin writing immediately. Do not read any files."**
- The agent performs **one real write**, then the session **pauses** instead of continuing through the implementation plan.
- The user-facing summary reports **files that were not actually written in that session**.
- `continue` does not resume deterministically because `nextToolCall` remains unset and there is no persisted implementation queue.
- A diagnostic follow-up such as **"why did you stop?"** still triggers a file mutation, which is an intent-routing bug.

Root cause:

> The runtime has improved file-writing capability, but the controller still does not own **task classification**, **plan progression**, **next-step scheduling**, and **session reporting** strongly enough.

---

## 2. Evidence from the latest failure

### 2.1 Wrong shape at run start
User intent:

```text
start implementing the system defined in requirements.md
```

Expected behavior:
- classify as requirements-driven greenfield implementation
- treat `requirements.md` as authoritative resolved input
- begin writing implementation artifacts directly

Observed behavior:
- execution began as patch-like behavior
- `list_files` happened even though input was already resolved
- session then paused after a single write

### 2.2 READY vs DISCOVER contradiction
The runtime simultaneously conveyed two incompatible states:

```text
READY ... Begin writing immediately. Do not read any files.
```

and later:

```text
STEP CONTRACT | discover: perform minimal targeted discovery before next mutation
```

This should be impossible in a correct controller.

### 2.3 Summary / ledger mismatch
The screen dump shows the model claiming writes such as:

```text
src/domain/user.py
src/domain/job_posting.py
src/domain/application.py
src/infrastructure/database.py
```

while the actual session ledger showed a different file write set. This means the UI summary is being produced from stale or inferred narrative context instead of the actual tool ledger.

### 2.4 Premature pausing
Every implementation turn ended with a form of:

```text
Paused — waiting for your input.
```

This happened even when the task was clearly a multi-file implementation and there was no blocker.

### 2.5 Diagnostic turn incorrectly mutated the project
User asked:

```text
why did you stop ?
```

Expected behavior:
- answer the diagnostic question only
- do not mutate workspace

Observed behavior:
- the runtime both explained itself and wrote another project file

---

## 3. Target architecture changes

This fix requires five controller-level changes:

1. **Requirements-driven implementation classification**
2. **READY-state precedence over discovery**
3. **Persistent implementation plan queue with mandatory `nextToolCall`**
4. **Deterministic, ledger-backed session summaries**
5. **Intent-sensitive resume routing for diagnostic vs continuation turns**

---

## 4. Fix 1 — Add a dedicated requirements-driven implementation template

### Problem
The classifier still does not treat:

```text
start implementing the system defined in requirements.md
```

as a strong greenfield implementation signal in a `docs_only` workspace.

### Required change
Add a new task template:

- `requirements_driven_build`

Behavior:
- requires resolved spec input
- no discovery once spec is loaded
- multi-file allowed
- bounded autonomous continuation allowed
- stop only on blocker, user interruption, or step budget

### Example template definition

```ts
// src/agents/execution/TaskTemplate.ts
export type TaskTemplateName =
  | 'single_file_creation'
  | 'existing_project_patch'
  | 'greenfield_scaffold'
  | 'requirements_driven_build'
  | 'multi_file_refactor';

export interface TaskTemplate {
  name: TaskTemplateName;
  requiresBatch: boolean;
  allowDiscovery: boolean;
  allowAutonomousContinuation: boolean;
  stopAfterWrite: boolean;
  description: string;
}

export const TASK_TEMPLATES: Record<TaskTemplateName, TaskTemplate> = {
  requirements_driven_build: {
    name: 'requirements_driven_build',
    requiresBatch: true,
    allowDiscovery: false,
    allowAutonomousContinuation: true,
    stopAfterWrite: false,
    description:
      'Implement a system from a resolved requirements/spec document. Do not rediscover once authoritative spec input is loaded.',
  },
  // existing templates...
};
```

### Classifier rule

```ts
// src/agents/execution/TaskClassifier.ts
function isRequirementsDrivenBuild(userText: string, workspaceType: WorkspaceType, resolvedInputs: string[]): boolean {
  const text = userText.toLowerCase();
  const referencesSpec =
    text.includes('requirements.md') ||
    text.includes('spec') ||
    text.includes('design document') ||
    text.includes('defined in requirements');

  const implementationIntent =
    text.includes('implement') ||
    text.includes('start implementing') ||
    text.includes('build the system');

  const hasResolvedSpec = resolvedInputs.some(p => /requirements\.md$/i.test(p));

  return implementationIntent && referencesSpec && hasResolvedSpec && workspaceType === 'docs_only';
}

export function classifyTask(ctx: ClassifierContext): TaskTemplateName {
  if (isRequirementsDrivenBuild(ctx.userText, ctx.workspaceType, ctx.resolvedInputs)) {
    return 'requirements_driven_build';
  }

  // existing rules continue below
  // ...
}
```

### Acceptance criteria
- `start implementing the system defined in requirements.md` in `docs_only` + resolved `requirements.md` must always classify to `requirements_driven_build`.
- `list_files` must not occur on first turn in that case.

---

## 5. Fix 2 — READY must hard-block discovery

### Problem
The controller emits a READY state but still allows discovery step contracts in the same run.

### Required change
Add a single controller precedence rule:

> If authoritative resolved inputs satisfy task preconditions, then discovery is forbidden for the current step unless a controller-owned blocker explicitly requires additional evidence.

### Example implementation

```ts
// src/agents/AgentRunner.ts
function canEnterDiscovery(state: ExecutionState, template: TaskTemplate): boolean {
  if (state.readyToWrite === true) {
    return false;
  }

  if (state.resolvedInputContents.length > 0 && state.preconditionsSatisfied === true) {
    return false;
  }

  return template.allowDiscovery;
}

function computeStepContract(state: ExecutionState, template: TaskTemplate): StepContract {
  if (!canEnterDiscovery(state, template)) {
    return {
      kind: 'mutate',
      instruction: 'Perform a file mutation now. Do not call read/list/search tools.',
      allowedTools: ['write_file', 'edit_file', 'replace_range', 'multi_edit', 'update_task_state'],
    };
  }

  return {
    kind: 'discover',
    instruction: 'Use minimal targeted discovery before mutation.',
    allowedTools: ['read_file', 'read_file_range', 'read_symbol_block', 'list_files'],
  };
}
```

### Required state fields
Add these if not already present:

```ts
interface ExecutionState {
  readyToWrite: boolean;
  preconditionsSatisfied: boolean;
  blockerReason?: string;
}
```

### Acceptance criteria
- If `requirements.md` is loaded as authoritative resolved input, discovery cannot be selected in the same turn.
- No `list_files` or `read_file` after READY unless a concrete blocker exists.

---

## 6. Fix 3 — Persist an implementation queue and always set `nextToolCall`

### Problem
The runtime still resumes with vague actions such as:

```text
Perform file mutation now — write or edit the next file.
```

but leaves `nextToolCall: none`.

That forces every `continue` through free-form model choice.

### Required change
Persist a controller-owned implementation plan:

```ts
// src/agents/ExecutionStateManager.ts
export interface PlannedArtifact {
  path: string;
  purpose: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  sourceRequirement?: string;
}

export interface ExecutionState {
  currentPlanId?: string;
  implementationPhase?: string;
  remainingArtifacts: PlannedArtifact[];
  completedArtifacts: PlannedArtifact[];
  currentArtifact?: PlannedArtifact;
  nextToolCall?: {
    tool: string;
    input: Record<string, unknown>;
    description?: string;
  } | null;
}
```

### Build initial queue from the requirement/spec
For a requirements-driven build, generate a controller-owned queue before first write.

Example queue:

```ts
const defaultInitialPlan: PlannedArtifact[] = [
  { path: 'backend/app.py', purpose: 'main API entrypoint', status: 'pending' },
  { path: 'backend/extractor.py', purpose: 'PDF extraction service', status: 'pending' },
  { path: 'backend/models.py', purpose: 'persistence models', status: 'pending' },
  { path: 'backend/requirements.txt', purpose: 'runtime dependencies', status: 'pending' },
  { path: 'frontend/package.json', purpose: 'frontend package manifest', status: 'pending' },
];
```

### Mandatory `nextToolCall` after write

```ts
// src/agents/ExecutionStateManager.ts
export function advanceImplementationQueue(state: ExecutionState): ExecutionState {
  const remaining = state.remainingArtifacts.filter(a => a.status !== 'done');
  const next = remaining[0] ?? null;

  return {
    ...state,
    currentArtifact: next ?? undefined,
    nextToolCall: next
      ? {
          tool: 'write_file',
          input: { path: next.path },
          description: `Write ${next.path}`,
        }
      : null,
  };
}
```

### AgentRunner pre-dispatch gate

```ts
// src/agents/AgentRunner.ts
if (state.nextToolCall && shouldDispatchDeterministically(state, currentUserIntent)) {
  return dispatchTool(state.nextToolCall);
}
```

### Acceptance criteria
- After each successful write, a new `nextToolCall` must exist if there are remaining artifacts.
- `continue` must not require the model to decide which file to work on next.

---

## 7. Fix 4 — Separate user-turn intent from long-running task intent

### Problem
The user turn:

```text
why did you stop ?
```

was treated as both explanation and continuation, which caused another mutation.

### Required change
Add a lightweight per-turn intent classifier that runs before resume logic.

### Intent types

```ts
type TurnIntent =
  | 'continue_task'
  | 'diagnostic_question'
  | 'status_question'
  | 'modify_scope'
  | 'new_task';
```

### Example classifier

```ts
// src/agents/TurnIntentClassifier.ts
export function classifyTurnIntent(text: string): TurnIntent {
  const t = text.trim().toLowerCase();

  if (t === 'continue' || t === 'go on' || t === 'resume implementation') {
    return 'continue_task';
  }

  if (t.includes('why did you stop') || t.includes('what happened') || t.includes('why did it pause')) {
    return 'diagnostic_question';
  }

  if (t.includes('status') || t.includes('what have you done so far')) {
    return 'status_question';
  }

  if (t.includes('instead') || t.includes('change') || t.includes('separate html from js')) {
    return 'modify_scope';
  }

  return 'new_task';
}
```

### Resume gate

```ts
// src/agents/AgentRunner.ts
const turnIntent = classifyTurnIntent(userMessage);

if (turnIntent === 'diagnostic_question' || turnIntent === 'status_question') {
  return renderNonMutatingAnswerFromExecutionState(state, turnIntent);
}

if (turnIntent === 'continue_task') {
  return resumePlannedExecution(state);
}
```

### Acceptance criteria
- `why did you stop?` must not write or edit any files.
- `continue` must resume deterministic execution.

---

## 8. Fix 5 — Build the final session summary from the tool ledger, not the model narrative

### Problem
The UI summary claimed files that were never written in that session.

### Required change
Stop asking the model to invent `Changed Files` from memory. Instead:

1. Build a normalized session ledger.
2. Render summary deterministically.
3. Allow the model to paraphrase only the deterministic payload.

### Example session ledger

```ts
// src/agents/SessionLedger.ts
export interface ToolLedgerEntry {
  turn: number;
  tool: string;
  path?: string;
  status: 'success' | 'error' | 'blocked';
  summary: string;
}

export interface SessionLedger {
  entries: ToolLedgerEntry[];
}

export function collectChangedFiles(entries: ToolLedgerEntry[]): string[] {
  return [...new Set(
    entries
      .filter(e => e.tool === 'write_file' || e.tool === 'edit_file' || e.tool === 'replace_range' || e.tool === 'multi_edit')
      .filter(e => e.status === 'success' && !!e.path)
      .map(e => e.path as string)
  )];
}
```

### Deterministic renderer

```ts
// src/agents/renderSessionSummary.ts
export function renderSessionSummary(ledger: SessionLedger): string {
  const changedFiles = collectChangedFiles(ledger.entries);
  const toolCount = ledger.entries.length;

  const changedBlock = changedFiles.length
    ? changedFiles.map(f => `- ${f}`).join('\n')
    : '- none';

  return [
    'Session Report',
    '',
    'Changed Files',
    changedBlock,
    '',
    `Tool operations: ${toolCount}`,
  ].join('\n');
}
```

### Hard consistency check

```ts
// src/agents/renderSessionSummary.ts
export function assertSummaryConsistency(ledger: SessionLedger, summaryFiles: string[]): void {
  const actual = new Set(collectChangedFiles(ledger.entries));
  const claimed = new Set(summaryFiles);

  for (const file of claimed) {
    if (!actual.has(file)) {
      throw new Error(`Summary claimed changed file not in ledger: ${file}`);
    }
  }
}
```

### Acceptance criteria
- Session report cannot name files absent from the success ledger.
- If synthesis fails, fall back to deterministic plain-text summary.

---

## 9. Fix 6 — Do not auto-pause after the first successful write in multi-file implementation tasks

### Problem
The runtime writes one file and then pauses, forcing repeated `continue` turns.

### Required change
For templates that support autonomous continuation, continue within the same session until:

- step budget reached,
- blocker encountered,
- user interruption,
- no remaining artifacts.

### Example loop

```ts
// src/agents/AgentRunner.ts
const MAX_AUTONOMOUS_STEPS = 5;

let steps = 0;
while (steps < MAX_AUTONOMOUS_STEPS) {
  if (state.blockerReason) break;
  if (!state.nextToolCall) break;
  if (!template.allowAutonomousContinuation) break;

  const result = await dispatchTool(state.nextToolCall);
  state = updateStateFromToolResult(state, result);

  if (result.status !== 'success') break;
  if (!state.remainingArtifacts.length) break;

  steps += 1;
}
```

### Acceptance criteria
- A requirements-driven build should progress through several planned artifacts in one session without needing `continue` after every write.
- If it stops, the stop reason must be explicit: blocker, completion, step budget, or user interruption.

---

## 10. Fix 7 — Add a deterministic stop reason and completion state

### Problem
The runtime ends with vague pause text instead of a structured stop reason.

### Required change
Add controller-owned final states:

```ts
type StopReason =
  | 'completed'
  | 'step_budget_reached'
  | 'blocked'
  | 'awaiting_user_decision'
  | 'user_interrupted'
  | 'diagnostic_answer_only';
```

### Example renderer

```ts
function renderStopReason(reason: StopReason): string {
  switch (reason) {
    case 'completed':
      return 'Completed — all planned implementation artifacts are done.';
    case 'step_budget_reached':
      return 'Paused — autonomous step budget reached. Say continue to proceed.';
    case 'blocked':
      return 'Paused — blocked by a missing dependency, input, or tool capability.';
    case 'awaiting_user_decision':
      return 'Paused — waiting for your decision on scope or direction.';
    case 'diagnostic_answer_only':
      return 'Answered your question. No files were modified.';
    default:
      return 'Paused.';
  }
}
```

### Acceptance criteria
- Every pause/completion must have an explicit controller-owned reason.
- "Paused — waiting for your input" must not be the default for successful multi-file progression.

---

## 11. Fix 8 — Protect the system against stale synthesis after degenerate-response recovery

### Problem
The log showed synthesis recovery producing wrong changed-files summaries.

### Required change
When a degenerate-response recovery happens, the runtime must:

- clear free-form changed-files memory for that turn,
- rebuild output solely from the tool ledger and execution state,
- disallow model-authored changed-files lists unless verified.

### Example guard

```ts
// src/agents/SynthesisGuard.ts
export function buildSafeSynthesisPayload(state: ExecutionState, ledger: SessionLedger) {
  return {
    objective: state.primaryObjective,
    changedFiles: collectChangedFiles(ledger.entries),
    filesRead: collectReadFiles(ledger.entries),
    lastActualWritePath: state.completedArtifacts.at(-1)?.path ?? null,
    stopReason: state.stopReason ?? null,
  };
}
```

### Acceptance criteria
- Degenerate-response fallback cannot introduce nonexistent files into the summary.

---

## 12. Required tests

### 12.1 Classification

```ts
it('classifies requirements-driven implementation in docs_only workspace correctly', () => {
  const result = classifyTask({
    userText: 'start implementing the system defined in requirements.md',
    workspaceType: 'docs_only',
    resolvedInputs: ['requirements.md'],
  });

  expect(result).toBe('requirements_driven_build');
});
```

### 12.2 READY overrides discovery

```ts
it('does not allow discovery when readyToWrite is true', () => {
  const contract = computeStepContract(
    {
      readyToWrite: true,
      preconditionsSatisfied: true,
      resolvedInputContents: ['requirements.md'],
    } as any,
    TASK_TEMPLATES.requirements_driven_build,
  );

  expect(contract.kind).toBe('mutate');
  expect(contract.allowedTools).not.toContain('read_file');
});
```

### 12.3 Diagnostic question does not mutate

```ts
it('does not mutate on diagnostic follow-up', async () => {
  const intent = classifyTurnIntent('why did you stop?');
  expect(intent).toBe('diagnostic_question');
});
```

### 12.4 Summary uses actual ledger only

```ts
it('does not report changed files absent from ledger', () => {
  const ledger = {
    entries: [
      { turn: 0, tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'ok' },
    ],
  };

  expect(() => assertSummaryConsistency(ledger as any, ['src/domain/user.py'])).toThrow();
});
```

### 12.5 Continue resumes deterministic next file

```ts
it('sets nextToolCall after successful write when artifacts remain', () => {
  const next = advanceImplementationQueue({
    remainingArtifacts: [
      { path: 'backend/extractor.py', purpose: 'extractor', status: 'pending' },
    ],
    completedArtifacts: [],
  } as any);

  expect(next.nextToolCall).toEqual({
    tool: 'write_file',
    input: { path: 'backend/extractor.py' },
    description: 'Write backend/extractor.py',
  });
});
```

---

## 13. Recommended implementation order

### Phase 1 — Controller correctness
1. Add `requirements_driven_build` template.
2. Patch task classifier.
3. Add READY-over-discovery precedence.
4. Add turn-intent classifier.

### Phase 2 — Deterministic continuation
5. Add persistent artifact queue.
6. Always compute `nextToolCall` after successful write.
7. Add bounded autonomous continuation loop.
8. Add structured stop reasons.

### Phase 3 — Reporting correctness
9. Add session ledger renderer.
10. Add summary consistency guard.
11. Add safe synthesis payload after degenerate-response recovery.

### Phase 4 — Tests
12. Add classification tests.
13. Add resume/continuation tests.
14. Add summary consistency tests.
15. Add diagnostic-turn non-mutation tests.

---

## 14. Definition of done

This fix is complete only when all of the following are true:

- `start implementing the system defined in requirements.md` in a docs-only workspace with resolved `requirements.md` begins directly under `requirements_driven_build`.
- No discovery tool is used after the system has already declared READY.
- The runtime performs multiple planned writes in one session without repeated manual `continue` prompts, subject to a bounded step budget.
- `continue` resumes from a controller-owned `nextToolCall`, not free-form model choice.
- `why did you stop?` answers only the question and does not mutate files.
- Session reports exactly match actual tool-ledger writes.
- No phantom files appear in `Changed Files`.

---

## 15. Final note to the team

Do not treat this as a prompt-tuning issue.

This is a **control-plane integrity** issue. The fix must be implemented in:

- task classification,
- controller precedence,
- persisted execution state,
- deterministic continuation,
- and deterministic reporting.

The model is not the source of truth for session progress. The controller and tool ledger must be.
