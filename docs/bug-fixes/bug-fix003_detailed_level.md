Below is a definitive development instruction set mapped to the current code objects in the repo.

## Objective

Refactor the execution engine so that **code-mode continuity is driven by structured execution state, not replayed transcript text**, and so that the controller can **reuse context cheaply, avoid redundant rereads, and skip unnecessary LLM calls**. The current code already has the right building blocks—`ExecutionStateManager`, `ToolDispatcher`, `PromptAssembler`, `RecoveryManager`, and `BatchEnforcer`—but they are not wired tightly enough. In particular, `AgentRunner` still loads full `sessionHistory`, `ExecutionStateManager.computeNextStep()` is too vague after reads, `ToolDispatcher` returns a soft `[Cached]` response rather than a durable blocked-read signal, `RecoveryManager` depends on `blockedReadCount`, and `AgentRunner.detectWorkspaceType()` diverges from `BatchEnforcer.detectWorkspaceType()`. ([GitHub][1])

# Design decision 1 — make `ExecutionStateData` the authoritative continuation model

## Required change

Use `ExecutionStateData` as the primary source of continuity for execution runs. Raw transcript history must become secondary and optional.

## Existing code objects

* `src/agents/ExecutionStateManager.ts`
* `src/agents/AgentRunner.ts`

## Implementation

Extend `ExecutionStateData` with the following persisted fields:

```ts
interface ResolvedInputSummary {
  path: string;
  hash: string;
  summary: string;
  kind: 'requirements' | 'plan' | 'source' | 'config' | 'other';
  lastReadAt: string;
}

interface ContextPacket {
  objective: string;
  mode: string;
  workspaceType: 'greenfield' | 'scaffolded' | 'mature';
  phase: SessionPhase;
  nextAction?: string;
  nextToolCall?: NextToolCall;
  approvedPlanPath?: string;
  resolvedInputs: ResolvedInputSummary[];
  recentArtifacts: string[];
  blockers: string[];
  compactMilestone?: string;
}
```

Add these fields to `ExecutionStateData`:

* `contextPacket?: ContextPacket`
* `approvedPlanPath?: string`
* `artifactStatus?: Record<string, 'drafted' | 'approved' | 'implemented' | 'superseded'>`
* `lastProgressAt?: string`
* `sameToolLoop?: { tool: string; path?: string; count: number }`

Keep `resolvedInputs: string[]` for backward compatibility, but migrate toward `ResolvedInputSummary[]` as the working structure. The current state model already stores objective, mode, resolved inputs, artifacts, next actions, and next tool call, so this is an additive evolution, not a rewrite. ([GitHub][2])

## Exact code tasks

1. In `ExecutionStateManager.createFresh()`, initialize the new fields.
2. In `_migrate()`, backfill them for older state files.
3. Add:

   * `setApprovedPlanPath(state, path)`
   * `setArtifactStatus(state, path, status)`
   * `upsertResolvedInputSummary(state, summary)`
   * `rebuildContextPacket(state, workspaceType)`

## Done criteria

* A resumed code session can be reconstructed using only `ExecutionStateData` plus the current user message.
* No implementation run should require replaying prior assistant narration to know what happened.

---

# Design decision 2 — stop feeding raw `sessionHistory` into execution-mode control flow

## Root issue

`AgentRunner` still builds `messages` with full `sessionHistory` before adding artifact notes and execution-state notes. Even though code mode later uses `PromptAssembler`, the global `messages` array still influences recovery and transcript persistence, which is exactly how stale “I’ll start by reading…” narration keeps surviving. ([GitHub][1])

## Existing code objects

* `src/agents/AgentRunner.ts`
* `src/agents/execution/TranscriptSanitiser.ts`
* `src/agents/execution/PromptAssembler.ts`

## Implementation

In `AgentRunner.run()`:

### Replace this pattern

```ts
const sessionHistory = await this.memoryManager.getSessionHistoryWithMemory(agentId);
const messages: ChatMessage[] = [
  { role: 'system', content: fullSystem },
  ...sessionHistory,
];
```

### With this pattern

```ts
const sessionHistory = await this.memoryManager.getSessionHistoryWithMemory(agentId);
const executionHistory = mode === 'code'
  ? await this.buildExecutionHistory(agentId, execState)
  : sessionHistory;

const messages: ChatMessage[] = [
  { role: 'system', content: fullSystem },
  ...executionHistory,
];
```

Add a new private method in `AgentRunner`:

```ts
private async buildExecutionHistory(
  agentId: string,
  execState: ExecutionStateData
): Promise<ChatMessage[]> { ... }
```

### Rules for `buildExecutionHistory`

For `mode === 'code'`, return at most:

* one system message with artifact registry
* one system message with compact execution-state note
* one assistant milestone line if needed
* zero raw previous assistant narration lines
* zero previous user turns except the most recent unresolved blocker turn if explicitly required

Do **not** pass through free-form assistant text that begins with patterns such as:

* `I'll start by`
* `Let me first`
* `First, let me`
* `I can see from the log`
* `I will now read`

Expand `TranscriptSanitiser.sanitiseContent()` to remove these repetitive execution-narration templates before persistence in code mode. The current sanitiser strips protocol noise, but not low-value agent narration. ([GitHub][3])

## New helper

Create:

`src/agents/execution/ExecutionHistoryReducer.ts`

Responsibilities:

* reduce raw memory into execution-safe compact messages
* discard speculative assistant narration
* preserve only:

  * milestone summaries
  * explicit blocker summaries
  * explicit completion summaries

## Done criteria

* Code mode must not replay full prior chat turns.
* The repeated “I’ll start by reading the plan…” strings must disappear from future runs.

---

# Design decision 3 — unify workspace classification and make it authoritative

## Root issue

`BatchEnforcer.detectWorkspaceType()` and `AgentRunner.detectWorkspaceType()` use different heuristics. `BatchEnforcer` classifies greenfield as “no `package.json` and no `src/`”, while `AgentRunner` can classify docs-heavy repos as mature based on non-hidden file count. That mismatch directly corrupts prompt behavior because `buildWorkspaceSummary()` tells mature repos to read key files before modifying. ([GitHub][4])

## Existing code objects

* `src/agents/execution/BatchEnforcer.ts`
* `src/agents/AgentRunner.ts`
* `src/agents/execution/PromptAssembler.ts`

## Implementation

Delete or stop using `AgentRunner.detectWorkspaceType()` as an independent classifier.

### Replace in `AgentRunner.run()`

```ts
const wsType = await this.detectWorkspaceType();
```

### With

```ts
const batchEnforcer = new BatchEnforcer(this.workspaceRoot);
const wsType = await batchEnforcer.detectWorkspaceType();
```

If `BatchEnforcer` is already instantiated earlier, reuse that instance.

### Strengthen `BatchEnforcer.detectWorkspaceType()`

Change classification rules to:

```ts
greenfield:
  no package.json
  no src/
  no backend/
  no frontend/
  sourceCount === 0

scaffolded:
  package.json or src/backend/frontend exists
  sourceCount < 5

mature:
  sourceCount >= 5
  or known project structure + source content
```

Do not use markdown/doc counts in workspace maturity.

### Update `buildWorkspaceSummary()`

In `PromptAssembler.ts`, change greenfield message from “Workspace is empty” to:

* `[Greenfield] No runnable code scaffold yet. Documentation may exist. Start by declaring the file batch and writing the first scaffold file.`

That avoids misleading the model in doc-only repos. ([GitHub][5])

## Done criteria

* A repo containing only docs and `.bormagi/plans` must classify as `greenfield`, not `mature`.
* Workspace note must drive scaffolding, not rediscovery.

---

# Design decision 4 — convert reread prevention from a soft message into a controller signal

## Root issue

`ToolDispatcher` currently returns a plain `[Cached] ... Use it directly — do not re-read.` string if a file is already in `resolvedInputs` or runtime cache. That is too soft. `RecoveryManager` only fires after `blockedReadCount >= 3`, but `ToolDispatcher` does not appear to increment that counter when it returns the cached message. ([GitHub][6])

## Existing code objects

* `src/agents/execution/ToolDispatcher.ts`
* `src/agents/ExecutionStateManager.ts`
* `src/agents/execution/RecoveryManager.ts`
* `src/agents/AgentRunner.ts`

## Implementation

Introduce a structured dispatcher result:

```ts
export interface DispatchResult {
  text: string;
  status: 'success' | 'blocked' | 'cached' | 'budget_exhausted';
  reasonCode?: 
    | 'ALREADY_READ_UNCHANGED'
    | 'DISCOVERY_BUDGET_EXHAUSTED'
    | 'BATCH_REQUIRED'
    | 'BORMAGI_PATH_BLOCKED';
  toolName: string;
  path?: string;
}
```

Change `ToolDispatcher.dispatch()` to return `DispatchResult`, not plain `string`.

### For reread prevention

When `read_file` hits an unchanged file:

* return:

```ts
{
  text: `[Cached] "${normPath}" already resolved. Use stored summary.`,
  status: 'cached',
  reasonCode: 'ALREADY_READ_UNCHANGED',
  toolName: 'read_file',
  path: normPath
}
```

### Immediately in `AgentRunner`

Handle `DispatchResult.reasonCode === 'ALREADY_READ_UNCHANGED'` by:

1. incrementing `execState.blockedReadCount`
2. updating `execState.sameToolLoop`
3. saving state
4. **not** treating the result as a normal productive tool step

### Add in `ExecutionStateManager`

```ts
incrementBlockedRead(state, path: string): void
recordToolLoop(state, tool: string, path?: string): void
resetToolLoop(state): void
```

## Done criteria

* Same-file rereads become machine-detectable controller events.
* Recovery can trigger on real blocked-read state instead of guessing from text.

---

# Design decision 5 — make `computeNextStep()` concrete and write-oriented

## Root issue

`ExecutionStateManager.computeNextStep()` still returns vague advice after reads, such as “Proceed to implementation — write or edit a file...” or “Read the most relevant file...”. That is not strong enough to stop loops. ([GitHub][2])

## Existing code objects

* `src/agents/ExecutionStateManager.ts`
* `src/agents/AgentRunner.ts`

## Implementation

Replace the current generic read handlers with deterministic next-step synthesis.

### Required new method

Add to `ExecutionStateManager`:

```ts
computeDeterministicNextStep(
  state: ExecutionStateData,
  workspaceType: WorkspaceType
): { nextAction: string; nextToolCall?: NextToolCall } | null
```

### Logic

1. If `approvedPlanPath` exists and `artifactStatus[approvedPlanPath] === 'approved'` and no source files exist:

   * `nextAction = 'Declare implementation batch and write first scaffold file'`
   * `nextToolCall = { tool: 'declare_file_batch', input: { files: [...] } }`

2. If batch exists and first file not written:

   * `nextToolCall = write_file(firstBatchFile)`

3. If a requirements/plan file was just read in greenfield:

   * synthesize the starter batch
   * do **not** return another read instruction

4. If a plan file was just read in code mode and batch already exists:

   * `nextToolCall = write_file(next remaining batch file)`

### Remove or rewrite these current branches

* `Proceed to implementation — write or edit a file based on what you just read`
* `Read the most relevant file, or start writing if you have enough context`

Those branches must become deterministic. ([GitHub][2])

## Done criteria

* After reading an approved plan, the next step must be a write-oriented tool or batch declaration, not another advisory sentence.

---

# Design decision 6 — make `RecoveryManager` act on deterministic state, not vague fallbacks

## Root issue

`RecoveryManager.shouldRecover()` is sound, but `rebuild()` still falls back to generic instructions like “Start implementation from the beginning” if `nextActions` and `nextToolCall` are empty. That fallback is too broad and reopens the loop. ([GitHub][7])

## Existing code objects

* `src/agents/execution/RecoveryManager.ts`
* `src/agents/ExecutionStateManager.ts`
* `src/agents/AgentRunner.ts`

## Implementation

In `RecoveryManager.rebuild()`:

### Replace fallback chain

```ts
if (this.execState.nextToolCall?.description) ...
else if ((this.execState.nextActions ?? []).length > 0) ...
else if (lastTool !== 'none') ...
else ...
```

### With

```ts
const deterministic = this.stateManager.computeDeterministicNextStep(this.execState, this.workspaceType);
if (deterministic?.nextToolCall) { ... }
else if (this.execState.nextToolCall) { ... }
else if ((this.execState.nextActions ?? []).length > 0) { ... }
else if (deterministic?.nextAction) { ... }
else { set RECOVERY_REQUIRED }
```

Inject `ExecutionStateManager` into `RecoveryManager` constructor so it can reuse the exact same next-step synthesizer.

### New rule

For `REPEATED_BLOCKED_READS`, recovery must never emit “read the plan”, “continue”, or “start implementation from the beginning”.
It must choose one of:

* `declare_file_batch`
* `write_file(next batch file)`
* `RECOVERY_REQUIRED`

## Done criteria

* Recovery rebuilds to a concrete next step.
* No generic restart text remains in recovery for code mode.

---

# Design decision 7 — add a `ContextPacketBuilder` and use summaries instead of raw file content

## Objective

Reduce context-window cost by storing compact summaries for unchanged files.

## Existing code objects

* `src/agents/ExecutionStateManager.ts`
* `src/agents/execution/PromptAssembler.ts`
* `src/agents/AgentRunner.ts`

## New files

* `src/agents/execution/ContextPacketBuilder.ts`
* `src/agents/execution/FileSummaryStore.ts`

## Implementation

### `FileSummaryStore`

Responsibilities:

* compute hash of file content after successful `read_file`
* persist summary for each resolved file
* expose `getSummary(path, hash)`

```ts
interface FileSummaryStore {
  put(path: string, hash: string, summary: string, kind: ResolvedInputSummary['kind']): Promise<void>;
  get(path: string, hash: string): Promise<ResolvedInputSummary | null>;
}
```

### `ContextPacketBuilder`

Build packet from:

* `ExecutionStateData`
* workspace type
* last tool result
* latest user instruction

Output:

* compact state summary
* compact workspace summary
* top 3 relevant resolved input summaries
* next action
* next tool call description

### AgentRunner integration

Before every provider call in code mode:

1. call `ContextPacketBuilder.build(...)`
2. pass packet output into `PromptAssembler.assembleMessages(...)`
3. do **not** inject raw plan/requirements content if hash unchanged and summary exists

## Done criteria

* Requirements and plan files are summarized once per content hash.
* Repeated turns inject summaries, not full contents.

---

# Design decision 8 — shrink provider requests by removing transcript replay in code mode entirely

## Existing code objects

* `src/agents/execution/PromptAssembler.ts`
* `src/agents/AgentRunner.ts`

## Implementation

The current `PromptAssembler` already assembles a compact code-mode prompt from:

* system prompt
* execution state summary
* workspace summary
* optional milestone
* current instruction
* current-step tool results only ([GitHub][5])

That design is correct. The issue is that surrounding control flow still maintains and mutates a much larger `messages` transcript.

### Required changes

1. In code mode, maintain two arrays:

   * `providerMessages`: built fresh each iteration from `PromptAssembler`
   * `auditTranscript`: minimal, sanitized, non-authoritative log for UI/audit only
2. Do not append prior `sessionHistory` into `providerMessages`.
3. Do not pass rebuilt `messages` history through recovery and then back into provider calls for code mode.

### New `AgentRunner` split

```ts
let providerMessages: ChatMessage[];
let auditTranscript: ChatMessage[];
```

Use `providerMessages` for LLM calls, `auditTranscript` for memory persistence and debugging.

## Done criteria

* Code-mode provider request size stays roughly bounded over long runs.
* Audit history can grow without increasing request size.

---

# Design decision 9 — add controller-side direct dispatch for deterministic steps

## Existing code objects

* `src/agents/AgentRunner.ts`
* `src/agents/ExecutionStateManager.ts`

## Implementation

The runner already direct-dispatches `nextToolCall` on continue. Extend that to normal loop progression. ([GitHub][1])

### New rule in `AgentRunner`

Before each provider call:

1. call `computeDeterministicNextStep()`
2. if it returns a `nextToolCall`, dispatch it directly if:

   * last action was blocked read
   * same-tool loop count >= 2
   * current phase is greenfield bootstrap
   * approved plan exists and no batch declared

This avoids paying for an LLM turn just to decide an obvious next move.

## Done criteria

* After repeated cached rereads, controller bypasses the LLM and executes the stored/synthesized next tool.
* Expensive filler turns are removed from deterministic phases.

---

# Design decision 10 — explicitly model plan approval and artifact lifecycle

## Existing code objects

* `src/agents/ExecutionStateManager.ts`
* artifact registry loader methods in `AgentRunner.ts`

## Implementation

When a plan file is created in plan mode:

* register it in `artifactStatus[path] = 'drafted'`

When user says plan approved:

* resolve the winning plan path
* set:

  * `approvedPlanPath = path`
  * `artifactStatus[path] = 'approved'`
  * `nextAction = 'Declare implementation batch and write first scaffold file'`

### New helper in `AgentRunner`

```ts
private resolveApprovedPlanPath(
  execState: ExecutionStateData,
  registeredArtifactPaths: string[],
  userMessage: string
): string | null
```

### New helper in `ExecutionStateManager`

```ts
markPlanApproved(state: ExecutionStateData, path: string): void
```

## Done criteria

* Once a plan is approved, future code-mode turns must default to implementation.
* The controller must not reread all plan files to guess which one is approved.

---

# Design decision 11 — extend transcript sanitization for execution filler

## Existing code objects

* `src/agents/execution/TranscriptSanitiser.ts`

## Implementation

Extend `sanitiseContent()` with execution-filler removal for persisted assistant turns in code mode:

```ts
.replace(/^(I'll start by reading[^\n]*|Let me first read[^\n]*|First, let me read[^\n]*|I'll start implementation based on[^\n]*)$/gim, '')
```

Also collapse repeated boilerplate lines that differ only slightly.

### Important rule

Only apply these extra filters when persisting assistant text for `mode === 'code'`. Do not use them in general chat/ask mode.

## Done criteria

* Repetitive execution narration no longer pollutes future sessions.
* Sanitizer remains conservative outside code mode.

---

# Design decision 12 — add cost telemetry tied to context sources

## Existing code objects

* `src/agents/AgentRunner.ts`
* audit logger path already used for request size logging

## New file

* `src/agents/execution/ContextCostTracker.ts`

## Implementation

Track, per code-mode LLM call:

* tokens from system prompt
* tokens from execution state summary
* tokens from workspace summary
* tokens from skill fragments
* tokens from current instruction
* tokens from current-step tool results
* number of resolved summaries reused
* number of raw file contents injected
* number of LLM calls skipped due to direct dispatch

Log through existing audit logger.

## Done criteria

* Team can verify that context cost is decreasing after these changes.
* Regressions are visible in telemetry.

---

# File-by-file implementation list

## 1. `src/agents/ExecutionStateManager.ts`

Implement:

* new state fields: `contextPacket`, `approvedPlanPath`, `artifactStatus`, `sameToolLoop`, richer resolved input summaries
* new methods:

  * `rebuildContextPacket`
  * `upsertResolvedInputSummary`
  * `incrementBlockedRead`
  * `recordToolLoop`
  * `resetToolLoop`
  * `markPlanApproved`
  * `computeDeterministicNextStep`
* replace vague `computeNextStep()` behavior with deterministic write-oriented outcomes

## 2. `src/agents/AgentRunner.ts`

Implement:

* `buildExecutionHistory()`
* use `BatchEnforcer.detectWorkspaceType()` as the only workspace classifier
* stop injecting raw `sessionHistory` into code-mode provider flow
* maintain separate `providerMessages` and `auditTranscript`
* consume structured `DispatchResult`
* direct-dispatch deterministic next steps outside explicit continue flow
* resolve and persist approved plan path

## 3. `src/agents/execution/ToolDispatcher.ts`

Implement:

* structured `DispatchResult`
* durable blocked-read reporting with `reasonCode`
* same-tool/path loop updates via execution state
* no plain string-only signaling for cache hits

## 4. `src/agents/execution/RecoveryManager.ts`

Implement:

* constructor injection of `ExecutionStateManager`
* deterministic next-step reuse in `rebuild()`
* no generic restart fallbacks for code mode

## 5. `src/agents/execution/BatchEnforcer.ts`

Implement:

* stronger classification rules
* no docs-count effect on workspace maturity
* central workspace-type authority

## 6. `src/agents/execution/PromptAssembler.ts`

Implement:

* use new context-packet output
* preserve compact structure
* no history replay additions

## 7. `src/agents/execution/TranscriptSanitiser.ts`

Implement:

* code-mode filler suppression
* execution narration de-duplication

## 8. New files

Create:

* `src/agents/execution/ExecutionHistoryReducer.ts`
* `src/agents/execution/ContextPacketBuilder.ts`
* `src/agents/execution/FileSummaryStore.ts`
* `src/agents/execution/ContextCostTracker.ts`

---

# Mandatory test cases

## Unit

1. `ExecutionStateManager.computeDeterministicNextStep()`:

   * approved plan + greenfield + no batch -> `declare_file_batch`
   * batch exists + first file pending -> `write_file(first pending)`
   * repeated blocked read -> deterministic non-read next action

2. `BatchEnforcer.detectWorkspaceType()`:

   * docs-only repo -> `greenfield`
   * package.json + 2 source files -> `scaffolded`
   * 5+ source files -> `mature`

3. `TranscriptSanitiser`:

   * removes repetitive code-mode filler
   * preserves non-execution natural text

## Integration

1. Resume from approved plan:

   * no reread of plan
   * batch declared
   * first scaffold written

2. Same-file reread loop:

   * first read succeeds
   * second read returns `ALREADY_READ_UNCHANGED`
   * after threshold, controller dispatches next deterministic step without LLM

3. Long session:

   * provider prompt size remains bounded
   * transcript growth does not cause linear token growth

---

# Definition of done

This work is complete only when all of the following are true:

* code-mode continuity comes from `ExecutionStateData` and compact summaries, not transcript replay
* docs-only repos classify as greenfield
* unchanged plans/requirements are reused via summaries and hashes instead of reread/reinjection
* repeated cached rereads trigger controller action, not another LLM narration cycle
* approved plans drive implementation directly
* per-turn prompt size stays bounded in long runs
* audit/history can grow independently of provider context size

The current repo already gives you the correct foundation: persisted execution state, compact prompt assembly, recovery triggers, and batch enforcement are all present; this plan turns them into one coherent control loop. ([GitHub][2])



[1]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/AgentRunner.ts "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/ExecutionStateManager.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/TranscriptSanitiser.ts "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/BatchEnforcer.ts "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/PromptAssembler.ts "raw.githubusercontent.com"
[6]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/ToolDispatcher.ts "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/RecoveryManager.ts "raw.githubusercontent.com"
