I think the current root cause is **not one bug**, but a bad interaction between **history replay**, **weak recovery triggers**, and **wrong workspace classification**.

## What the new log shows

The code-mode session is still being primed with the **entire previous planning exchange**, including the old user request and the assistant’s old narration. In the code-mode run, the prompt contains the old user turn `write a detailed plan...`, the old planning narration, then the new execution-state note, and only then the new user turn `plan approved, start implementation based on your plan`. That is why the model keeps echoing plan-reading language instead of starting to write files. 

The agent does successfully read the plan once, but after that it keeps calling `read_file` on the same `.bormagi/plans/...md` path and receives the cached “already read” response over and over, while the discovery-budget warning keeps escalating from 3 to 15 consecutive reads with nothing written. That means the system is **detecting** no-progress but not **forcing** a state transition. 

There is also still obvious transcript pollution from prior sessions. Older logs show long stretches of self-referential text like “I can see from the log that I was in plan mode...” being replayed and then re-read on resume. That pattern is exactly the kind of contamination that later becomes nonsense in the next session.

## What in the codebase explains it

`AgentRunner` still builds the prompt by taking the full persistent `sessionHistory` and appending it directly into `messages` before the new execution-state note and current user message. That means stale plan-session narration is still entering the next code session as normal conversational history. ([GitHub][1])

You already added state reconciliation and seeded the reread cache, which is good: `reconcileWithUserMessage(...)` is now called before building the context note, and `ToolDispatcher.setExecutionState(...)` plus `seedReadCache(...)` are wired in. ([GitHub][1])

But the reread handling is still too soft. `ToolDispatcher` returns a `[Cached] ... Use it directly — do not re-read.` response when a file was already read, instead of turning that into a stronger blocked condition with durable state updates. I could not find any `blockedReadCount` update inside `ToolDispatcher`, even though `RecoveryManager` depends on `blockedReadCount >= 3` to trigger `REPEATED_BLOCKED_READS`. ([GitHub][2])

`ExecutionStateManager.computeNextStep()` also remains too weak after reads. For any normal `read_file`, it only sets a vague next action like “Proceed to implementation — write or edit a file...”, and for `list_files` it says “Read the most relevant file, or start writing...”. In a looping model, that is not deterministic enough to break the cycle because it does not generate a concrete `nextToolCall` to write the first file. ([GitHub][3])

There is also a workspace-classification bug. `BatchEnforcer` defines greenfield as “no `package.json` and no `src/`”. ([GitHub][4]) But `AgentRunner.detectWorkspaceType()` uses a different heuristic: if there are more than two non-hidden files, it classifies as mature even without `package.json` or `src/`. In your log, the workspace only contains markdown/docs plus `.bormagi`, yet the prompt says `[Workspace: Mature] Existing codebase...`. That pushes the model toward more reading instead of scaffolding or writing.  ([GitHub][1])

## Root cause summary

1. **Stale conversational history is still injected into fresh runs.**
   The old planning dialogue is being replayed as normal history, so the model keeps imitating it.  ([GitHub][1])

2. **Repeated cached rereads do not escalate into a hard controller action.**
   The system warns, but does not switch strategy automatically. `RecoveryManager` wants `blockedReadCount`, but that counter is not clearly being driven by the dispatcher.  ([GitHub][2])

3. **Next-step synthesis is too vague after read operations.**
   The agent gets “proceed to implementation” instead of “call `write_file` for X now”. ([GitHub][3])

4. **Workspace maturity is misclassified.**
   A docs-only workspace is being labelled “mature”, which biases the agent toward more inspection.  ([GitHub][1])

## Fixing plan

### Priority 1 — stop transcript replay into execution sessions

**Task 1: stop loading raw sessionHistory into code-mode resumes**

* In `AgentRunner`, do not prepend full `sessionHistory` for code execution resumes.
* Replace it with a **sanitized execution summary** only:

  * current objective
  * files read
  * files written
  * completed steps
  * next pending action
* For code mode, exclude prior assistant narration that begins with patterns like:

  * “I’ll start by...”
  * “Let me read...”
  * “I can see from the log...”
* Keep raw history only for chat/ask modes, not execution modes. ([GitHub][1])

**Task 2: harden assistant-history persistence**

* When persisting assistant text, discard speculative narration if a tool call followed immediately.
* Store only:

  * final summary text, or
  * milestone text, or
  * explicit completion/blocker text
* Do not persist planning narration such as “First, let me read the plan...” into memory for future execution turns. `AgentRunner` already sanitizes some protocol text, but it needs a stronger filter for execution-narration patterns. ([GitHub][1])

### Priority 2 — make reread loops trigger forced recovery

**Task 3: convert repeated cached rereads into durable blocked-read state**

* In `ToolDispatcher`, when `read_file` returns the cached reread response, increment `execState.blockedReadCount`.
* Save execution state immediately after that increment.
* Include the file path in the blocked-read record. ([GitHub][2])

**Task 4: after N cached rereads, bypass the LLM and force the next write-oriented step**

* Threshold recommendation: 2 or 3 repeated cached rereads of the same file with no writes.
* On threshold:

  * if `nextToolCall` exists, dispatch it directly
  * else synthesize a concrete write/scaffold `nextToolCall`
  * else enter recovery rebuild
* Do not merely append another discovery-budget warning.  ([GitHub][5])

### Priority 3 — make next actions concrete, not advisory

**Task 5: strengthen `computeNextStep()`**
Replace vague read follow-ups with deterministic actions:

* After reading a plan file in code mode:

  * set `nextAction = "Write the first implementation file now"`
  * set `nextToolCall = write_file(...)` for the first scaffold file
* After listing files in a greenfield/docs-only workspace:

  * set `nextAction = "Declare file batch and write backend/app/main.py"`
  * set `nextToolCall = declare_file_batch(...)`

Right now `computeNextStep()` is informative but too weak to steer a stuck model. ([GitHub][3])

**Task 6: require a non-empty concrete next action after every successful read**

* If the last successful tool was `read_file` and no concrete next tool was produced, treat that as an orchestration defect.
* Auto-repair by generating a concrete write step. ([GitHub][3])

### Priority 4 — fix workspace classification

**Task 7: unify workspace classification**
Use one shared classifier only. Right now:

* `BatchEnforcer` says no `package.json` and no `src/` = greenfield
* `AgentRunner.detectWorkspaceType()` can still say mature if there are several docs files

That divergence must be removed. `AgentRunner` should call `BatchEnforcer.detectWorkspaceType()` or both should share one utility. ([GitHub][4])

**Task 8: treat docs-only workspaces as greenfield/scaffolded**

* Presence of markdown design docs must not imply “mature codebase”.
* Recommended rule:

  * no `package.json`, no `src`, no `backend`, no `frontend` → greenfield
  * has project directories but low source count → scaffolded
  * only then mature

This change matters because your current prompt is telling the agent to “read key files before modifying” when it should be scaffolding and writing.  ([GitHub][1])

### Priority 5 — add controller-level anti-nonsense guard

**Task 9: detect repetitive narration templates**
Add a controller guard before each new LLM turn:

* if assistant text in the last 2–3 iterations matches repetitive templates like:

  * “I’ll start by reading the plan...”
  * “Let me first read the plan...”
  * “I’ll start implementation based on the approved plan...”
* and no file was written,
  then:
* suppress those messages from history
* inject a system command:

  * `TOOL ONLY — do not narrate. Write the first implementation file now.`
* or dispatch the synthesized next tool directly. 

**Task 10: add a same-tool same-path loop breaker**
If the same tool/path pair is requested repeatedly, for example:

* `read_file(.bormagi/plans/pdf-upload-extraction-html-export-system.md)` 3+ times
  with no mutation in between,
  stop the loop and hard-redirect. 

## Recommended implementation order

1. Remove raw history replay in code-mode resumes
2. Increment and persist `blockedReadCount` on cached rereads
3. Force recovery or direct action after repeated cached rereads
4. Make `computeNextStep()` produce concrete `nextToolCall`s after reads
5. Unify workspace classification with `BatchEnforcer`
6. Add repetitive-narration and same-tool/path loop breakers

## Short diagnosis

The repo is better than before because state reconciliation and cross-session reread seeding are now present. But the agent still fails because the current code-mode run is polluted by old planning narration, cached rereads are treated as advisory rather than terminal for that strategy, and the workspace is being mislabelled as mature, so the model keeps “reading the plan” instead of writing the first file.  ([GitHub][1])


[1]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/AgentRunner.ts "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/ToolDispatcher.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/ExecutionStateManager.ts "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/BatchEnforcer.ts "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/RecoveryManager.ts "raw.githubusercontent.com"
