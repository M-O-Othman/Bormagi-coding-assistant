Below is the **unified implementation list** that merges:

* the **remaining repo enhancements**, and
* the **new issues confirmed by the latest log**,

in a form ready to send directly to the implementation team.

## Unified implementation list

1. **Make `executionEngineV2` the default execution path after regression tests pass.**
   The repo still keeps V2 behind `bormagi.executionEngineV2=false` by default, so the old path can still run. Keep the flag for rollout, but switch the default to V2 once tests are green, then remove the old path in a follow-up cleanup. ([GitHub][1])

2. **Collapse `AgentRunner` into a coordinator and remove duplicate V1/V2 orchestration.**
   `AgentRunner.ts` is still the oversized hot path and still contains mixed orchestration concerns. Refactor it so it only:

   * loads execution state,
   * assembles prompt input,
   * routes tool calls through `ToolDispatcher`,
   * persists state updates,
   * emits final summaries.
     Move remaining enforcement and protocol handling out of `AgentRunner`. ([GitHub][1])

3. **Stop replaying full system prompt + resume blocks + old conversation fragments on every LLM call.**
   The log still shows repeated reinjection of the long system prompt, execution-state block, workspace-status block, and prior assistant/tool chatter. Replace replay-heavy prompt assembly with:

   * stable system prompt once,
   * compact execution-state summary,
   * compact workspace summary,
   * current user instruction,
   * current-step structured tool results only. 

4. **Keep tool results visible to the LLM only through a structured tool channel, never as pseudo-chat.**
   The log still contains `<tool_result ...>`, `TOOL:list_files:...`, and `[write_file: ...]` style protocol leakage. Remove these from normal conversation assembly. Use:

   * provider-native `tool` role when available,
   * otherwise a dedicated internal structured tool-result block.

5. **Apply transcript sanitisation on every prompt assembly, not just selectively.**
   Even though transcript sanitisation exists, the log still shows protocol-like noise appearing in the conversational stream. Ensure the sanitizer runs before **every** LLM request and strips:

   * `[write_file: ...]`
   * `TOOL:...`
   * XML tool wrappers
   * fake bootstrap/ack text
   * internal control markers. ([GitHub][2])

6. **Make `nextAction` the only authoritative resume pointer for `continue`.**
   The flow still needs repeated `continue` prompts because resume is too transcript-dependent. When user says `continue`, the engine must:

   * load task state,
   * read `nextAction`,
   * show one short resume line,
   * execute immediately.
     Do not rebuild intent from prior transcript unless `nextAction` is missing or invalid.

7. **Fix terminal/wait-state handling so the run actually stops when a prerequisite deliverable is complete.**
   In the log, the agent writes `open_questions.md` and then continues exploring `.bormagi` instead of stopping to wait for user answers. Add an explicit terminal state such as:

   * `WAITING_FOR_USER_INPUT`
   * `BLOCKED_ON_ANSWERS`
   * `BATCH_COMPLETE`
     and end the run immediately when such a state is reached.

8. **Enforce `.bormagi/**` blocking for agent tool calls in all modes.**
   The log confirms the agent still lists `.bormagi` and reads `.bormagi/project.json`. This must be blocked at the dispatcher/tool layer. Framework code may read internal files and inject compact summaries, but normal agent-exposed tool calls must not access `.bormagi/**`. 

9. **Make discovery budget truly blocking in the dispatcher.**
   The log shows “Stop reading — write your first file now” yet the agent continues discovery. Enforce hard limits in `ToolDispatcher`:

   * max `read_file` per run: 3
   * max `list_files` per run: 2
   * max consecutive discovery calls without a write: 3
     Once exhausted, block further discovery until a write/edit/validation/recovery step occurs.

10. **Reset discovery counters only on successful write/edit, not on narration or blocked attempts.**
    The guard should be driven by executed tool results only. A narrated intention or blocked tool call must not reset the counter. This prevents the agent from “talking its way around” the discovery budget. 

11. **Harden silent execution mode so “do not narrate” suppresses pre-tool chatter reliably.**
    The user still has to keep saying “Call the next tool now. Do not narrate — execute immediately.” Make `silentExecution` a run-scoped flag that strips assistant chatter before the next tool call, except for the minimal resume line when appropriate.

12. **Treat speculative assistant protocol text as non-authoritative and never persist it.**
    Strings like `[write_file: src/main.ts ...]` or `TOOL:...` must never update:

    * artifact registry,
    * execution state,
    * created-file lists,
    * resume context.
      Only successful executed tool results may mutate state.

13. **Strengthen artifact-aware write/edit selection.**
    The log shows an attempted `write_file open_questions.md` failing because the file already existed. Before any write:

    * check artifact registry / execution state,
    * if file exists, prefer `edit_file`,
    * if file does not exist, allow `write_file`.
      This decision should be made in orchestration before the model proposes the wrong tool. 

14. **Make batch enforcement authoritative only where required, but actually enforce it.**
    Keep the current intended policy:

    * mandatory for greenfield/scaffold tasks,
    * optional for existing-project single-file edits.
      But once a batch is declared, block off-batch writes unless there is an explicit batch amendment. ([GitHub][1])

15. **Keep architecture lock automatic by default and enforce it before structural writes.**
    For existing projects, infer architecture from project files and imports. For greenfield tasks, infer it from the plan and first scaffold decision. Prevent silent framework switching mid-task. If the user overrides the lock, invalidate or rebuild the active batch. ([GitHub][1])

16. **Wire `ConsistencyValidator` into the hot path after each mandatory batch and on meaningful multi-file edits.**
    The validator exists, but it must be called automatically after a batch chunk or multi-file structural change. Use the agreed behavior:

    * auto-fix safe issues,
    * warn on non-critical unresolved issues,
    * block on critical issues only. ([GitHub][3])

17. **Turn validator output into structured execution-state data and short user-facing summaries.**
    Persist:

    * severity (`info`, `warning`, `critical`)
    * file
    * rule
    * auto-fixed or not
    * blocking or not
      Surface only the compact result to chat/UI; do not replay raw validator logs into the LLM transcript. ([GitHub][3])

18. **Add a hard milestone finaliser so sessions do not end “silently” in the middle of work.**
    Every session must end in exactly one of these states:

    * `COMPLETED`
    * `WAITING_FOR_USER_INPUT`
    * `BLOCKED_BY_VALIDATION`
    * `PARTIAL_BATCH_COMPLETE` with persisted `nextAction`
    * `RECOVERY_REQUIRED`
      This will reduce silent stopping and repeated manual `continue` prompts.

19. **Add recovery mode when state, transcript, and artifact registry disagree.**
    Trigger recovery if:

    * repeated blocked reads,
    * repeated `continue` with no progress,
    * artifact registry says file exists but model proposes `write_file`,
    * protocol text appears in transcript,
    * `nextAction` is missing or invalid.
      Recovery should rebuild compact state from executed tool history only, not from transcript replay.

20. **Keep debug commands developer-mode gated, but make them operationally useful.**
    Keep:

    * `bormagi.showExecutionState`
    * `bormagi.resetExecutionState`
      behind developer mode only, and ensure:
    * `showExecutionState` shows compact task state,
    * `resetExecutionState` clears only execution state, not project files. ([GitHub][4])

21. **Retain the current minimal dependency-audit scope for now, but add execution-path verification next.**
    Do not widen to full-repo dependency cleanup yet. First verify compilation/runtime for the modified execution-layer files, then add a focused verification step for the new path. The current package scripts still indicate the repo is not yet strongly execution-verified by default. ([GitHub][5])

22. **Add focused regression tests for the exact failures seen in the log.**
    Required tests:

    * tool results never appear as user messages
    * protocol markers are removed before prompt send
    * `.bormagi/**` access is blocked for agent tool calls
    * reread prevention works
    * discovery budget blocks correctly
    * `continue` resumes from `nextAction`
    * existing artifact chooses `edit_file` not `write_file`
    * silent execution suppresses chatter
    * wait-state stops execution cleanly
    * validator auto-fix/warn/block behavior works

23. **Make workspace classification stable and state-driven, not transcript-driven.**
    The log shows the workspace and “currently editing” context drifting across sessions, even pointing at internal log files. Build workspace classification from authoritative state plus real filesystem checks, not from replayed transcript or last-chat metadata.

24. **Reduce `AgentRunner` size after behavior is stable.**
    Once the above fixes are in place and tests pass, split `AgentRunner` into smaller units:

    * run bootstrap / state load
    * prompt assembly
    * tool loop coordination
    * resume handling
    * finalisation
      This is not the first step, but it is necessary to keep the solution maintainable long term. ([GitHub][1])

25. **Final rollout sequence for implementation team.**
    Implement in this order:

    1. tool-result isolation + transcript sanitisation enforcement
    2. `nextAction`-based continue/resume
    3. hard silent-execution + discovery-budget enforcement
    4. `.bormagi` blocking
    5. artifact-aware write/edit selection
    6. wait-state / milestone finaliser
    7. validator hot-path integration
    8. recovery mode
    9. make V2 default
    10. remove V1 path after regression tests pass. ([GitHub][1])

## Acceptance criteria for “flow fixed”

26. The agent must no longer require repeated manual `continue` prompts for normal progress.
27. The agent must stop cleanly when it reaches a wait state or milestone boundary.
28. The prompt sent to the model must no longer contain duplicate long prompt/history blocks.
29. No raw tool protocol text may appear in assembled prompts or persisted chat history.
30. The agent must never directly access `.bormagi/**` through normal tool calls.
31. Discovery-budget violations must block immediately.
32. Existing files in artifact registry must be edited, not rewritten.
33. `continue` must execute from `nextAction`, not from transcript reconstruction.
34. V2 should become the only supported execution path after the regression suite passes.

This is the **implementation-ready merged list**.

[1]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/AgentRunner.ts "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/TranscriptSanitiser.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/agents/execution/ConsistencyValidator.ts "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/src/extension.ts "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/M-O-Othman/Bormagi-coding-assistant/master/package.json "raw.githubusercontent.com"
