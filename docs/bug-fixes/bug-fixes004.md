Below is a developer-ready defect list with fixes and acceptance criteria.

## P0 — Stop the freeze loop

### 1) Re-read loop on the same plan file

**Symptom**
The agent repeatedly reads `.bormagi/plans/pdf-extraction-system-plan.md`, first getting cached-read guidance, then repeated `[LOOP DETECTED]`, but still keeps trying to read it again instead of progressing.

**Root cause**
The runtime still lets the model choose the same discovery step after a blocked/cached read. Cached-read and loop-detected signals are informational, not state-changing.

**Fix**

* Add `readCooldown` / `blockedReadSet` to execution state.
* When a file returns:

  * `[Cached] ... already read this session`
  * `[LOOP DETECTED] ... stop reading`
    mark that file as **non-readable for the rest of the run** unless a write to that file occurs.
* `ToolDispatcher` must reject repeated reads of blocked paths with a structured blocked result:

  * `reasonCode = "READ_ALREADY_SATISFIED"`
* `PromptAssembler` must inject a compact hint:

  * `blockedReads=[".bormagi/plans/pdf-extraction-system-plan.md"]`
* `RecoveryManager` should trigger if the model attempts the same blocked read twice after warning.

**Acceptance criteria**

* In a live run, after one cached/loop-detected read of a file, the agent does not read that same file again in the same run unless the file was modified.
* No run shows 3+ reads of the same path with no writes in between.

---

### 2) Discovery-budget warnings do not force a productive transition

**Symptom**
The runtime emits `[Discovery Budget] 3 consecutive reads with nothing written yet. Stop reading — write your first file now.`, but the run continues with more reads/listings and repeated narration instead of moving to a valid write or terminal recovery path.

**Root cause**
Discovery budget enforcement warns, but does not change the control flow.

**Fix**

* Make discovery-budget overrun a **hard phase transition**:

  * from `DISCOVERING` → `EXECUTING_STEP` if a valid next write exists
  * else `RECOVERING`
  * else `BLOCKED`
* Add a dispatcher-level guard:

  * once over budget, disallow `read_file`, `list_files`, and `grep_content` until either:

    * a write/edit succeeds
    * recovery rebuilds state
    * the run terminates
* The next LLM prompt after budget exhaustion must include only:

  * objective
  * blocked discovery note
  * allowed next actions
    not the full transcript.

**Acceptance criteria**

* After discovery budget is exceeded, the next tool call is either:

  * `write_file` / `edit_file` / `multi_edit`
  * `declare_file_batch`
  * recovery action
  * terminal stop
* No additional discovery calls are accepted after budget lockout.

---

### 3) `declare_file_batch` is not idempotent

**Symptom**
The agent repeatedly declares new file batches for the same task instead of writing the first file. The same run shows multiple `declare_file_batch` calls with overlapping scaffolds.

**Root cause**
Batch declaration is treated as a normal tool with no “already satisfied” state.

**Fix**

* Persist `activeBatchId`, `batchDeclared=true`, `batchFiles`, and `batchObjectiveHash`.
* If the same or equivalent batch is declared again:

  * return `BATCH_ALREADY_ACTIVE`
  * do **not** append another batch tool result into prompt history
* Require first file write within N steps after batch declaration (recommended: 2).
* If no file is written after N steps:

  * trigger recovery
  * or invalidate the batch and force minimal batch rebuild

**Acceptance criteria**

* A run can have at most one active batch per objective unless recovery explicitly resets it.
* After batch declaration, the agent writes a listed file within 2 subsequent actionable steps.

---

## P0 — Fix hard runtime bugs

### 4) Redirected `write_file → edit_file` fails because `edit_file` is unavailable

**Symptom**
The runtime redirected `.gitignore` from `write_file` to `edit_file`, but then failed with `Error: Unknown tool: edit_file`. 

**Root cause**
Artifact-aware redirect logic is active before tool registration parity is guaranteed.

**Fix**

* Ensure `edit_file` is registered in:

  * MCP server
  * dispatcher allowlist
  * provider tool schema
  * mode-filter path
* Add startup assertion:

  * if redirect target tool is unavailable, fail fast during initialization
* Add integration test:

  * `write_file(existingPath)` redirects and succeeds via `edit_file`

**Acceptance criteria**

* Redirect path cannot produce “Unknown tool” in any mode/runtime path.
* Existing-file writes succeed through the redirect path.

---

### 5) `write_file` can be called with `content=undefined`

**Symptom**
`write_file` fails with `TypeError [ERR_INVALID_ARG_TYPE] ... Received undefined`.

**Root cause**
Malformed tool payloads are reaching the filesystem layer without validation, likely after loop/recovery/redirect paths.

**Fix**

* Add strict payload validation before dispatch:

  * `path: non-empty string`
  * `content: string` for `write_file`
* On invalid payload:

  * do not call tool
  * return structured error:

    * `reasonCode = "INVALID_TOOL_PAYLOAD"`
* Add tool-call schema validation in dispatcher, not only provider-side.
* Add runtime logging for malformed payload origin:

  * last prompt type
  * last recovery state
  * last redirect state

**Acceptance criteria**

* No filesystem call receives undefined content.
* Invalid payloads are rejected before reaching the tool implementation.
* Live runs surface structured invalid-payload errors instead of Node exceptions.

---

## P1 — Fix control flow and prompt assembly

### 6) Prompt replay is still transcript-driven

**Symptom**
Each LLM call still includes the full system prompt, execution-state block, workspace note, original user request, assistant narration, and prior tool results. The same “I’ll start by reading…” / “Now let me…” text is replayed across calls.

**Root cause**
Prompt assembly is still conversation-history based instead of step-state based.

**Fix**

* Replace “append transcript” logic in code mode with `PromptAssembler.buildCompactExecutionPrompt()`
* For code mode include only:

  * stable system prompt
  * compact execution state
  * current objective
  * current task template
  * active batch summary
  * last tool result(s) only
  * blocked tool/read sets
* Exclude:

  * prior assistant narration
  * earlier tool results
  * original user message after first normalization
* Cap prior tool-result window to 1 step in code mode.

**Acceptance criteria**

* By call #N, the prompt no longer includes all prior assistant text/tool results.
* Token growth between consecutive calls is bounded and proportional to the current step only.

---

### 7) Tool results are still treated as conversation content

**Symptom**
Tool results are still being injected back into the message stream as `<tool_result ...>` blocks. That preserves the same failure mode even though formatting improved.

**Root cause**
Tool output is still in the conversational channel instead of an execution-state channel.

**Fix**

* Stop persisting tool results as user-role or pseudo-user transcript entries.
* Store them in:

  * tool ledger
  * execution state
  * current-step scratch context
* PromptAssembler should convert only the latest relevant tool result into a compact structured note:

  * `lastTool={"name":"read_file","status":"cached","path":"..."}`
* Sanitize historical transcript on prompt assembly.

**Acceptance criteria**

* Prompt history does not contain raw tool_result wrappers from earlier steps.
* Resume works from state, not from replayed tool transcripts.

---

### 8) `Iterations used so far` / state counters are unreliable

**Symptom**
Earlier runs repeatedly showed `Iterations used so far: 0`; this log still shows inconsistent progress behavior relative to actual calls and state transitions. Similar stale state problems appear elsewhere in prior runs.

**Root cause**
Execution-state persistence is not the single authoritative source across all paths.

**Fix**

* Persist and update on every tool call / LLM step:

  * `iterationCount`
  * `consecutiveDiscoveryCount`
  * `consecutiveNarrationCount`
  * `lastProgressAt`
  * `lastMutationAt`
* Only display values from persisted execution state.
* Add invariant checks:

  * iteration count must monotonically increase
  * mutation count must reflect successful writes/edits

**Acceptance criteria**

* Logged iteration counts match actual step progression.
* Recovery and continue use accurate counters.

---

## P1 — Stop narration drift

### 9) Silent execution is not actually enforced

**Symptom**
Despite explicit user instructions like “Call the next tool now. Do not narrate — execute immediately.”, the agent keeps producing narration such as “I’ll start by…” and “Now let me…”.

**Root cause**
Silent mode is advisory, not enforced.

**Fix**

* In `silentExecution=true`:

  * strip narration if a valid tool call exists
  * do not show narration to the user
  * do not count stripped narration as progress
* If text-only output arrives with no valid tool call:

  * internal reprompt once with `TOOL ONLY`
  * then classify as blocked if still invalid
* Add `consecutiveNarrationCount` and trigger recovery after threshold (recommended: 2).

**Acceptance criteria**

* In strict silent mode, the user sees tool execution, not preparatory narration.
* Repeated narration without tool progress triggers recovery/block.

---

## P1 — Remove harmful framework bias

### 10) Workspace summary is imperative and misleading

**Symptom**
The framework says `[Workspace: Greenfield] No project files. Start by creating a project structure...` even though markdown files and `.bormagi` are present. That biases the model toward scaffold behavior prematurely.

**Root cause**
Workspace classification is too naive and the summary includes instructions instead of facts.

**Fix**

* Classifier should distinguish:

  * empty workspace
  * docs-only workspace
  * scaffolded project
  * mature project
* Replace imperative text with neutral summary only, e.g.:

  * `workspaceType=docs_only`
  * `topLevelFiles=[...]`
  * `projectManifestPresent=false`
* Remove “Start by creating...” style instructions from workspace notes.

**Acceptance criteria**

* Workspace summary is factual, not directive.
* Docs-only workspaces are not mislabeled as empty greenfield.

---

### 11) `.bormagi` is still in the productive execution loop

**Symptom**
The agent depends on `.bormagi/plans/pdf-extraction-system-plan.md` during code execution and gets stuck around it. That makes framework-owned files part of the normal implementation loop.

**Root cause**
Framework and agent responsibilities are not fully separated.

**Fix**

* Block normal code-mode reads of `.bormagi/**` from agent tools.
* Framework may read needed `.bormagi` files and inject compact facts into state.
* If a plan file in `.bormagi` is the approved source:

  * framework should normalize it once into execution state
  * agent should not re-read it directly

**Acceptance criteria**

* Code-mode agent does not read `.bormagi/**` directly during normal implementation.
* Approved-plan content is available via compact execution-state injection.

---

## P2 — Clean up prompt and runtime quality

### 12) Prompt assembly corruption / string-quality bug

**Symptom**
Header shows `Advanced 9Coder` instead of `Advanced Coder`. That indicates prompt assembly corruption or bad string replacement. 

**Root cause**
Prompt composition is brittle.

**Fix**

* Audit prompt-concatenation and interpolation code.
* Add snapshot tests for:

  * agent header
  * mode header
  * workspace block
  * execution-state block
* Fail test on unexpected prompt mutations.

**Acceptance criteria**

* No corrupted prompt labels or malformed headers in logs.
* Prompt snapshots are stable across runs.

---

### 13) `currently editing ""` or stale editor context should be removed

**Symptom**
Earlier runs showed empty or stale “currently editing” values; this field has repeatedly added noise and confusion across sessions. Similar issues are visible in older logs in the same uploaded file set.

**Root cause**
UI/editor state is drifting into execution prompt.

**Fix**

* Remove `currently editing` from code-mode system prompt.
* If retained later, populate only from execution state:

  * current batch target
  * most recent mutated file

**Acceptance criteria**

* No empty or stale “currently editing” field appears in execution prompts.

---

## Verification work the team must add

### Regression tests

Add tests for:

* repeated read of same file after cached/loop warning
* budget exhaustion → no further discovery allowed
* `write_file(existingPath)` redirect succeeds
* invalid write payload rejected before tool dispatch
* repeated batch declaration returns `BATCH_ALREADY_ACTIVE`
* silent mode strips narration when tool call exists
* `.bormagi` blocked in code mode
* compact prompt excludes old tool results

### Live-session acceptance scenarios

Run at least these end-to-end tests:

1. **Docs-only greenfield task**

   * read two docs
   * list workspace once
   * declare batch once
   * first write occurs within 2 actionable steps
2. **Existing-file redirect**

   * write to `.gitignore`
   * redirect to `edit_file`
   * succeeds
3. **Budget overrun**

   * repeated read attempts
   * budget locks discovery
   * run transitions to write/recovery/block, not more reads

---

## Recommended implementation order

1. Fix payload validation for `write_file`
2. Fix `edit_file` registration parity
3. Make `declare_file_batch` idempotent
4. Hard-lock discovery after budget exhaustion
5. Add blocked-read set / read cooldown
6. Remove `.bormagi` from normal code-mode tool access
7. Replace transcript replay with compact code-mode prompt assembly
8. Enforce silent execution strictly
9. Fix workspace classification and remove imperative workspace hints
10. Add prompt snapshot tests and live-session verification

If you want, I’ll next convert this into a **flat task list with file-level ownership** such as `AgentRunner.ts`, `PromptAssembler.ts`, `ToolDispatcher.ts`, `ExecutionStateManager.ts`, and MCP tool server changes.
