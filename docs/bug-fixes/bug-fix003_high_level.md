Below is a developer-focused bug-fix and enhancement list to make the agent more context-aware and reduce expensive redundant LLM context injection.

# Context-awareness and context-cost reduction task list

## 1. Make execution state the primary memory, not chat history

### Bug fix

Stop using raw conversation history as the main source of continuity for code/execution sessions.

### Enhancement

Create a canonical `ExecutionSessionState` object that is the only authoritative source for:

* current task id
* current phase
* approved plan path
* resolved requirements/spec files
* files already read
* files already written
* pending next action
* pending next tool call
* workspace classification
* blockers
* recovery counters
* last meaningful result

### Required change

Every new turn in execution mode must reconstruct prompt context from `ExecutionSessionState`, not from raw prior assistant narration.

### Acceptance criteria

If the agent already read `requirements.md` and the approved plan, the next turn must explicitly know that without replaying earlier assistant text.

---

## 2. Separate conversational memory from operational memory

### Bug fix

The system currently appears to mix:

* user/assistant chat transcript
* execution progress state

This causes polluted resumes and repeated file-reading.

### Enhancement

Introduce two isolated stores:

### A. `ConversationMemory`

For user-visible dialogue only.

### B. `OperationalMemory`

For machine-usable execution state only.

### Required change

Execution-mode prompt builder must pull almost everything from `OperationalMemory`, and only minimal recent user intent from `ConversationMemory`.

### Acceptance criteria

A previous assistant sentence like “I’ll start by reading the plan” must never be reused as operational context.

---

## 3. Stop replaying assistant narration into execution prompts

### Bug fix

Do not inject assistant narration such as:

* “I’ll start by reading...”
* “Let me examine...”
* “First, I will...”

into later code-mode turns.

### Enhancement

Add a persistence filter that discards low-value assistant narration from long-term session memory.

### Required change

Persist only:

* tool results
* final milestone summaries
* explicit blockers
* explicit completion summaries
* structured decisions

Discard or heavily compress:

* speculative narration
* repeated planning phrases
* procedural filler

### Acceptance criteria

Prompt history for execution mode must contain no repetitive “I’ll start by reading...” strings.

---

## 4. Build a compact context packet instead of reinjecting full window contents

### Bug fix

The system is likely paying too much by rebuilding large context windows every turn.

### Enhancement

Create a compact `ContextPacket` generated from state, containing only:

* task objective
* current phase
* approved artifacts
* relevant files already read
* relevant files changed
* next concrete action
* constraints
* workspace summary
* last tool result
* unresolved blockers

### Required change

Prompt assembly for execution turns must prefer `ContextPacket` over full session replay.

### Target size

Keep standard execution context packet under a strict token budget, for example:

* soft target: 1k–2k tokens
* hard cap: 4k tokens

### Acceptance criteria

A long session should not cause linear growth in per-turn prompt size.

---

## 5. Add context tiers and inject only what is needed

### Enhancement

Create multi-tier context retrieval:

### Tier 1: mandatory

Always inject:

* current user instruction
* canonical task objective
* current phase
* next action
* last tool result

### Tier 2: situational

Inject only if relevant:

* approved plan summary
* requirements summary
* file-specific notes
* workspace classification

### Tier 3: on-demand

Fetch only when needed:

* full plan text
* full requirements text
* old conversation excerpts

### Required change

Do not inject Tier 2/3 by default.

### Acceptance criteria

The model should not receive the full plan or full requirements on every turn if they were already summarized into structured state.

---

## 6. Cache semantic summaries of files instead of reinjecting full file contents

### Bug fix

Repeatedly injecting the same file content is expensive and unnecessary.

### Enhancement

For each read file, store:

* file hash
* file path
* last read timestamp
* structured summary
* key entities
* key requirements/decisions
* whether full content is still needed

### Required change

When a file is unchanged, inject its summary by default, not its full contents.

### Escalation rule

Only inject full file contents if:

* the model is about to edit it
* the summary is insufficient
* the file changed
* the file is short enough and immediately relevant

### Acceptance criteria

Repeated reads of large spec files must be replaced by hash-based summary reuse.

---

## 7. Add file-hash-based context reuse

### Enhancement

Track content hashes for all important files.

### Required change

If a file hash is unchanged since last read:

* do not reread file
* do not reinject full content
* reuse stored summary and resolved facts

If hash changed:

* invalidate summary
* permit reread
* regenerate summary

### Acceptance criteria

The agent must treat unchanged files as already-known context.

---

## 8. Make “resolved inputs” first-class and authoritative

### Bug fix

The system knows files were read, but that knowledge is not strong enough in later turns.

### Enhancement

Create a `ResolvedInputsRegistry` containing:

* path
* hash
* source type
* summary
* resolved facts
* allowed reread conditions

### Required change

Before any `read_file`, the controller must check the registry.
If already resolved and unchanged:

* block reread
* inject the resolved facts instead

### Acceptance criteria

The agent should not ask to reread requirements or approved plan unless they changed or explicit user instruction requires it.

---

## 9. Replace vague next steps with concrete next tool calls

### Bug fix

Vague guidance like “Proceed to implementation” invites the model to fall back to more reading.

### Enhancement

After each tool result, compute:

* `nextAction`
* `nextToolCall`
* `fallbackToolCall`

### Required change

Example:

* after reading approved plan in implementation mode:

  * `nextAction = Write first backend scaffold`
  * `nextToolCall = write_file("backend/app.py", ...)`

### Acceptance criteria

Execution state must never end a turn with only abstract advice.

---

## 10. Add direct controller actions to bypass redundant LLM turns

### Bug fix

Too many LLM turns are being spent on obvious transitions.

### Enhancement

When the next tool step is deterministic, skip an LLM round entirely.

### Examples

If:

* file already read
* workspace greenfield
* batch not declared
* next file known

then controller should:

* update state
* dispatch next tool or force a structured action
  without asking the LLM to “think” again.

### Acceptance criteria

Repeated blocked rereads should trigger controller action, not another LLM narration cycle.

---

## 11. Add a loop breaker for same-tool same-target repetition

### Bug fix

The agent keeps requesting the same read on the same file.

### Enhancement

Track repetitive tool patterns:

* same tool
* same path
* same result
* no state mutation between attempts

### Required change

If threshold exceeded:

* suppress another model turn
* mark strategy as invalid
* force alternate action

### Suggested thresholds

* 2 repeats: warning and redirect
* 3 repeats: hard block and forced recovery

### Acceptance criteria

No file should be read or requested more than the threshold without mutation.

---

## 12. Introduce a session-local workspace knowledge graph

### Enhancement

Build a compact structured map of the workspace:

* important files
* file roles
* artifact relationships
* plan → implementation targets
* requirements → files impacted
* files already handled

### Required change

Use this graph to answer:

* what has already been read
* what still needs to be written
* what file should be created next

### Acceptance criteria

The agent should know “approved plan exists and maps to backend/frontend scaffold files” without rereading the plan.

---

## 13. Unify workspace classification and make it stateful

### Bug fix

Docs-only workspaces are being misclassified as mature.

### Enhancement

Use one shared workspace classifier and persist its result in execution state.

### Recommended classification logic

* no source dirs and no build files → greenfield
* minimal scaffold only → scaffolded
* real source files present → mature

### Required change

Do not reclassify differently across modules unless filesystem changed.

### Acceptance criteria

A docs-only repo must not trigger “read key files before modifying” behavior intended for mature codebases.

---

## 14. Add task identity and task continuity detection

### Enhancement

Introduce a stable `taskId` / `taskFingerprint` derived from:

* user request
* workspace
* target artifact family

### Required change

On each new turn:

* determine whether this is continuation, branch, or new task
* load only matching execution state

### Acceptance criteria

A new implementation turn should continue the same approved-plan task instead of rebuilding from ambiguous transcript history.

---

## 15. Persist plan approval and artifact status explicitly

### Bug fix

The agent keeps rereading the plan because approval is not being operationalized strongly enough.

### Enhancement

Track artifact lifecycle state:

* drafted
* approved
* superseded
* implemented
* partially implemented

### Required change

If a plan is `approved`, the default next action must be implementation, not plan re-reading.

### Acceptance criteria

Approved plan status must change prompt behavior and controller behavior.

---

## 16. Add structured file summaries for plan and requirements artifacts

### Enhancement

When reading a plan or requirements file, immediately derive and store:

* scope summary
* implementation phases
* file targets
* dependencies
* acceptance criteria
* first actionable implementation steps

### Required change

The controller should later inject this structured summary instead of the raw file.

### Acceptance criteria

The model can begin implementation with only the structured artifact summary unless deeper detail is explicitly needed.

---

## 17. Introduce delta-context injection instead of full-context reinjection

### Enhancement

Each turn should inject only what changed since the last turn:

* last tool output
* state changes
* new file contents
* updated next action

### Required change

Maintain previous context packet hash and send only delta additions when possible.

### Acceptance criteria

Prompt growth should be near-constant, not cumulative.

---

## 18. Add token-budget management for execution mode

### Enhancement

Implement explicit budgeting:

* system prompt budget
* execution-state budget
* workspace summary budget
* artifact summary budget
* recent interaction budget

### Required change

If budget exceeded:

* compress lower-priority context
* remove stale narration
* prefer structured summaries over raw text

### Acceptance criteria

Prompt builder must never exceed budget by blindly replaying history.

---

## 19. Add cost telemetry and per-turn context diagnostics

### Enhancement

For every execution turn, log:

* total prompt tokens
* tokens by context source
* number of files injected
* number of summaries reused
* repeated context avoided
* LLM calls skipped by controller
* blocked rereads
* cost estimate

### Required change

Provide developer-visible diagnostics for:

* why context was injected
* why it was reused
* why an LLM call was made or skipped

### Acceptance criteria

The team should be able to identify expensive redundant context sources quickly.

---

## 20. Add summary compaction jobs for long-running sessions

### Enhancement

For long sessions, periodically compact accumulated state into a new authoritative summary:

* completed milestones
* remaining work
* known files
* decisions
* blockers
* next action

Then retire old transient state.

### Acceptance criteria

A 100-turn session should not require replaying 100 turns of context.

---

## 21. Add controller-enforced “tool-first” mode for deterministic phases

### Enhancement

In certain phases, the controller should strongly prefer tools over narration.

### Good candidates

* after approved plan exists
* after requirements read
* after scaffold decision
* after repeated blocked rereads

### Required change

Inject hard instruction:

* no explanatory narration
* perform next tool action directly

### Acceptance criteria

The agent should stop producing expensive filler turns in deterministic phases.

---

## 22. Add a “context freshness” model

### Enhancement

For each context item, track:

* freshness
* relevance
* volatility
* confidence

### Use

* stable unchanged requirements summary → high reuse
* current workspace listing after writes → may need refresh
* old assistant narration → low value, discard

### Acceptance criteria

Low-value stale context must not keep getting reinjected.

---

## 23. Implement selective retrieval from local state store

### Enhancement

Store execution context in a local indexed store and retrieve only matching slices by query:

* current phase
* current file
* current artifact
* current blocker

### Required change

Prompt builder must request only relevant slices, not everything known.

### Acceptance criteria

Reading backend implementation details should not inject frontend plan details unless needed.

---

## 24. Add tests specifically for context continuity and context-cost control

### Required tests

* same file already read, unchanged, next turn does not reread
* approved plan exists, implementation turn does not reread full plan
* long session prompt size remains bounded
* raw assistant narration not persisted into execution prompts
* repeated blocked rereads cause forced controller action
* unchanged file summary reused by hash
* docs-only workspace classified greenfield
* deterministic next tool step skips LLM call

---

## 25. Recommended implementation order

### Phase 1: stop the waste

1. Make execution state primary memory
2. Stop replaying assistant narration
3. Add compact context packet
4. Enforce resolved-input reuse
5. Add blocked-reread loop breaker

### Phase 2: reduce LLM cost

6. File-hash-based summary reuse
7. Delta-context injection
8. Token-budget manager
9. Direct controller action for deterministic steps
10. Cost telemetry

### Phase 3: improve intelligence

11. Workspace knowledge graph
12. Task continuity detection
13. Context freshness model
14. Selective local-state retrieval
15. Periodic summary compaction

---

## 26. Short diagnosis for the dev team

The current system appears to rebuild execution turns from too much raw transcript and too little authoritative structured state. That makes the agent appear context-blind and causes repeated expensive rereads and redundant LLM calls. The fix is to shift from transcript-driven continuation to state-driven continuation, use summaries and hashes instead of full reinjection, and let the controller handle deterministic next steps without repeatedly asking the LLM.


