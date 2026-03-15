Based on the log symptoms and the repo areas I reviewed, this is the fixing tasklist I would give the development team.

## Priority 0 — stop the infinite read loop

### Task 1: Enforce persisted no-reread rules in the actual dispatcher

**Problem:** `ExecutionStateData` persists `resolvedInputs` for cross-session no-reread enforcement, but `ToolDispatcher` visibly keeps its own per-run guard state with `filesReadThisRun` / `filesWrittenThisRun`. That split is exactly the kind of design that can allow loops after resume if the dispatcher only trusts per-run memory. ([GitHub][1])

**Fix work**

* Make `read_file` checks go through one authoritative function, not two separate rule systems.
* Wire `ToolDispatcher` to consult persisted execution state before dispatching a read.
* After a successful read, update persisted state immediately.
* After a write to the same file, explicitly allow read-after-write in both runtime and persisted state.
* Add unit tests for:

  * read once in session A, resume session B, same file blocked
  * read, write, then reread allowed
  * blocked reread does not trigger another identical tool dispatch

**Files**

* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/ExecutionStateManager.ts` ([GitHub][1])

---

### Task 2: Turn blocked rereads into a hard strategy switch

**Problem:** the log shows repeated rereads after “already read” responses. The repo already defines a recovery trigger named `REPEATED_BLOCKED_READS`, but the architecture only helps if blocked reads are counted and escalated. ([GitHub][2])

**Fix work**

* Increment a persisted `blockedReadCount` whenever a reread is denied because the file is already known and unchanged.
* When the threshold is hit, do not call the LLM again with the same context.
* Force one of:

  * execute `nextToolCall`
  * synthesize a write/scaffold next step
  * enter explicit recovery path
* Reset the counter on:

  * successful write
  * successful recovery
  * explicit task reset/new task

**Files**

* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/execution/RecoveryManager.ts`
* `src/agents/ExecutionStateManager.ts` ([GitHub][1])

---

## Priority 1 — fix stale resume state overriding the current request

### Task 3: Reconcile execution state with the latest user instruction before prompt assembly

**Problem:** `ExecutionStateData` persists `objective` and `mode`, and the comments explicitly frame them as cross-session task state. If that state is injected into the prompt before reconciliation with the latest user request, the agent can resume with the wrong objective or wrong mode, which matches the log. ([GitHub][1])

**Fix work**

* Add a `reconcileWithUserMessage()` step before any resume-context note is built.
* Compare new user request against stored objective:

  * same task continuation → update objective/mode/next actions
  * materially different task → fork/reset execution state
* Persist reconciled values before the first LLM call.

**Acceptance criteria**

* If user says “start implementation,” stored “make a plan” objective must not remain authoritative.
* If user says “continue,” prior state should still be reused safely.
* If user changes task, stale plan state must not bleed into the new run.

**Files**

* `src/agents/AgentRunner.ts`
* `src/agents/ExecutionStateManager.ts` ([GitHub][3])

---

### Task 4: Make latest explicit mode win over stale stored mode

**Problem:** `ExecutionStateData` stores `mode`, and `ModeClassifier` is only the auto-detect fallback when no explicit selection exists. That means the system should have a clear precedence rule, but the log suggests stored plan mode can survive into an implementation turn. ([GitHub][1])

**Fix work**

* Define precedence:

  1. explicit user-selected mode
  2. explicit mode implied by current command/action
  3. classifier fallback
  4. stored mode only as tie-breaker, never as override
* Add a guard that forbids prompt assembly with contradictory state such as:

  * objective says implement
  * mode says plan
* Emit a structured warning to logs when reconciliation changes mode.

**Files**

* `src/context/ModeClassifier.ts`
* `src/agents/AgentRunner.ts` ([GitHub][3])

---

## Priority 2 — make next-step execution deterministic

### Task 5: Guarantee `nextActions` or `nextToolCall` after every successful step

**Problem:** `ExecutionStateManager` defines structured resume support through `NextToolCall`, which is the right pattern, but the log behavior suggests the system often falls back to free-form model reasoning instead of deterministic continuation. ([GitHub][1])

**Fix work**

* After every successful tool call, compute and persist:

  * `nextActions[0]`
  * `nextToolCall` when derivable
* Reject transitions that leave the session in `RUNNING` with neither next action nor next tool call.
* Add a repair step:

  * if missing, synthesize the next action from tool result + workspace type + current phase

**Examples**

* after reading requirements in greenfield workspace → next action should become scaffold declaration or first file creation
* after creating a plan file → next action should be continue/edit same artifact or start implementation, not reread requirements

**Files**

* `src/agents/ExecutionStateManager.ts`
* `src/agents/AgentRunner.ts`
* `src/agents/execution/RecoveryManager.ts` ([GitHub][3])

---

### Task 6: Remove hardcoded generic recovery fallbacks

**Problem:** `RecoveryManager` exists to rebuild context from authoritative execution history, but generic fallback recovery text is exactly how an agent ends up repeating the wrong high-level step. ([GitHub][2])

**Fix work**

* Replace generic fallback next steps with state-derived next steps.
* Recovery must prefer:

  1. pending `nextToolCall`
  2. persisted `nextActions`
  3. workspace-type-driven action
  4. only then a generic restart/fresh-start action
* Add tests for:

  * repeated blocked reads
  * protocol text contamination
  * missing next action

**Files**

* `src/agents/execution/RecoveryManager.ts` ([GitHub][2])

---

## Priority 3 — enforce a real first-write path in greenfield workspaces

### Task 7: Make batch declaration mandatory and auto-suggested in greenfield/scaffolded workspaces

**Problem:** `BatchEnforcer` clearly states that greenfield/scaffolded workspaces must declare a batch before the first `write_file`. That is good, but the loop indicates the controller is not translating that rule into a deterministic next step. ([GitHub][4])

**Fix work**

* When workspace type is `greenfield` or `scaffolded` and no batch exists:

  * inject a structured required next action: declare batch
  * do not let the agent drift back into file discovery unless a missing input is truly unresolved
* After key requirements file is read, auto-propose starter file batch.
* If the agent tries to reread instead of declaring batch, block and redirect.

**Files**

* `src/agents/execution/BatchEnforcer.ts`
* `src/agents/AgentRunner.ts` ([GitHub][4])

---

### Task 8: Create a scaffold-first policy for empty workspaces

**Problem:** `BatchEnforcer` classifies greenfield as no `package.json` and no `src/`, and scaffolded as very few source files. In those cases the controller should not behave like a mature-project inspector. ([GitHub][4])

**Fix work**

* Add a policy:

  * greenfield + requirements already known → write scaffold, not inspect more
* Suggested sequence:

  1. declare file batch
  2. create root files
  3. create first source file
  4. only then continue implementation
* Add a “discovery exhausted in greenfield” guard that immediately flips to scaffold mode.

**Files**

* `src/agents/execution/BatchEnforcer.ts`
* `src/agents/AgentRunner.ts` ([GitHub][4])

---

## Priority 4 — remove contradictory internal artifact behavior

### Task 9: Stop leaking internal `.bormagi` paths into model-facing artifact continuation hints

**Problem:** your log showed internal-state path confusion. The repo comments say execution state is persisted under `.bormagi/exec-state-*.json`, so `.bormagi` is definitely internal framework state. That should not be mixed into normal user-workspace artifact continuation suggestions. ([GitHub][1])

**Fix work**

* Split artifact namespaces:

  * internal framework artifacts under `.bormagi`
  * user-visible work artifacts under workspace paths only
* Never instruct the model to inspect or continue internal `.bormagi` files directly.
* Build continuation hints only from user-visible artifact registry entries.
* Add tests to ensure internal paths are filtered before prompt injection.

**Files**

* artifact registry / prompt assembly path in `AgentRunner.ts`
* execution-state and artifact-resolution code around `ExecutionStateManager.ts` ([GitHub][3])

---

### Task 10: Deduplicate plan artifact creation

**Problem:** the repo README describes agent workflows with planning and handoffs, so duplicate plan-file creation is operationally expensive and confusing. The log already showed overlapping plan artifacts. The codebase needs a continuation-before-create rule. ([GitHub][5])

**Fix work**

* Before creating a new plan artifact:

  * search current task state for an existing plan file
  * if one exists, continue/update it unless the user explicitly asked for another variant
* Add plan artifact identity fields:

  * task id
  * artifact type
  * canonical path
  * status
* Reject duplicate creation when the same task already has an open plan artifact.

**Files**

* `src/agents/AgentRunner.ts`
* planning/artifact management modules linked from the runner ([GitHub][3])

---

## Priority 5 — strengthen observability and tests

### Task 11: Add explicit reason codes to blocked tool results

**Problem:** debugging this class of failure is hard unless the controller receives machine-readable reasons, not just text. The current architecture defines recovery triggers, but debugging and control become stronger if each blocked call returns a reason code. ([GitHub][2])

**Fix work**

* Standardize blocked results:

  * `ALREADY_READ_UNCHANGED`
  * `DISCOVERY_BUDGET_EXHAUSTED`
  * `BATCH_REQUIRED_BEFORE_WRITE`
  * `INTERNAL_PATH_FORBIDDEN`
* Log reason code, file path, current mode, current phase, workspace type.
* Make recovery and orchestration consume those codes instead of parsing strings.

**Files**

* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/execution/RecoveryManager.ts` ([GitHub][6])

---

### Task 12: Add end-to-end tests for the exact failure path from the log

**Problem:** this bug is orchestration-level, so unit tests alone are not enough.

**Fix work**
Create end-to-end tests for:

* typo read → corrected read → implementation start → no reread loop
* resume from plan task → user says implement → mode/objective reconciled
* greenfield workspace + requirements read → batch declared → first file written
* repeated blocked rereads → recovery fires → state advances
* internal `.bormagi` artifacts never shown as normal continuation targets

**Likely test targets**

* `AgentRunner`
* `ToolDispatcher`
* `RecoveryManager`
* `BatchEnforcer`
* `ExecutionStateManager` ([GitHub][3])

---

## Recommended implementation order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 7
7. Task 8
8. Task 9
9. Task 10
10. Task 11
11. Task 12

## Short diagnosis for the team

The repo already has the right building blocks: persisted execution state, recovery triggers, mode classification, and batch enforcement. The failure is that these mechanisms are not tightly connected, so stale resume state, per-run-only read guards, and weak next-step synthesis allow the agent to loop on reads instead of advancing to writes. ([GitHub][1])


[1]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/ExecutionStateManager.ts "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/RecoveryManager.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/AgentRunner.ts "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/BatchEnforcer.ts "raw.githubusercontent.com"
[5]: https://github.com/M-O-Othman/Bormagi-coding-assistant "GitHub - M-O-Othman/Bormagi-coding-assistant · GitHub"
[6]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/ToolDispatcher.ts "raw.githubusercontent.com"
