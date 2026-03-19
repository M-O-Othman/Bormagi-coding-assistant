# Bormagi Coding Assistant — Dev Team Instruction Document

Date: 2026-03-18
Scope: Consolidated findings from codebase review plus the supplied runtime log on 2026-03-18.

## Executive summary

The codebase has improved materially versus the earlier failure mode:
- single-file creation is now a first-class template;
- docs-only workspace detection exists;
- execution state supports `nextToolCall` for deterministic resume;
- recovery has a `MISSING_NEXT_ACTION` trigger.

However, the supplied runtime log shows the system is **still not controller-led enough**. The first single-file session succeeds on the first write, but follow-up behavior regresses into repeated, unnecessary rewrites; the controller keeps `nextToolCall: none`; the model is still allowed to choose tools in situations where the next action is already known; and tool-availability / environment mismatches create avoidable loops.

The result is not the old catastrophic discovery loop, but a new class of orchestration failures:
1. success is not recognized early enough,
2. mutation completion is not converted into a terminal or waiting phase,
3. repeated rewrites happen because `nextActions` stay stale,
4. unavailable tools (`edit_file`) are still presented as usable mutation paths,
5. shell commands are chosen that are invalid in the current host environment,
6. consistency checks are firing with rules that do not match the task shape.

## What the latest log proves

### A. Single-file creation classification now works
The first session starts correctly with:
- `template=single_file_creation`
- `requiresBatch=false`
- `No discovery — generate directly`

It immediately issues `write_file(index.html)` and succeeds.

Interpretation:
- The earlier misclassification bug (`existing_project_patch` for simple greenfield creation) is largely fixed.
- The single-file path is viable.

### B. The first-turn result is good, but the run does not end cleanly
After the first successful write of `index.html`, the model text says the app is complete and functional, but also says:
- “The agent is waiting for your input.”

Then the next session resumes with:
- `Resume implementation. Last completed: write_file. Next action: Write the requested file now.`
- `nextToolCall: none`

Interpretation:
- A successful single-file completion is **not being converted into a proper terminal or wait state with a cleared mutation agenda**.
- The system resumes as if more writing is still required.

### C. The controller still leaves too much discretion to the model
In the resumed single-file session, the state says:
- the file already exists (`index.html` in artifact registry),
- no re-read is needed,
- mutate now,
- `nextActions = [Write the requested file now...]`,
- but `nextToolCall: none`.

The model then chooses:
- `run_command: ls -lh index.html`

This is both unnecessary and wrong for the environment.

Interpretation:
- The architecture still depends on free-form model choice when the controller already knows the correct branch.
- `nextToolCall` is still under-populated on the main execution path.

### D. Environment-aware command selection is broken
The command `ls -lh index.html` fails with:
- `'ls' is not recognized as an internal or external command`

Interpretation:
- The agent is running in a Windows-style command environment or at least one without `ls`, but shell command generation is not platform-aware.
- The system allowed a pointless inspection command despite already having authoritative state.

### E. Artifact guard works, but the recovery path is still poor
After the first file exists, `write_file(index.html)` triggers artifact guard auto-load. The system correctly loads the file into context and offers mutation-oriented alternatives.

But the loop continues because:
- `nextActions` still say “Write the requested file now...”
- `nextToolCall` remains `none`
- the model keeps trying whole-file replacement
- auto-redirect changes `write_file → edit_file`
- `edit_file` is not actually available
- the loop repeats several times

Interpretation:
- Artifact guard behavior is better than before, but the mutation strategy after conflict is still not normalized into a real, available next tool.
- The engine knows enough to avoid repeated rewrites, but does not enforce it.

### F. Tool-availability awareness is incorrect
The system auto-redirects to `edit_file`, then the tool layer returns:
- `Tool "edit_file" not found in any running MCP server.`

This happens repeatedly.

Interpretation:
- Prompt/tool contract and actual MCP capability set are inconsistent.
- The planner is allowed to select tools not present in the runtime.
- Auto-redirect logic is not gated by actual tool availability.

### G. The session should have terminated much earlier
The second session performs repeated writes/attempted edits of the same file with no meaningful new evidence and no verification, while:
- `loopDetections: 0`
- `recoveryAttempts: 0`
- `deterministicDispatches: 0`

Interpretation:
- Existing recovery triggers are too narrow.
- The engine lacks a "repeated same-target mutation with no progress" detector.

### H. Follow-up refactor request mostly works, but still wastes one step
For `ok separate html from js and css`, the run starts with:
- `template=existing_project_patch`
- minimal discovery
- `list_files`
- `read_file(index.html)`
- then writes `index.html`, `styles.css`, `script.js`

This is broadly acceptable for a refactor request. But there are still issues:
- one unnecessary `list_files` happened even though artifact registry already knew `index.html` existed;
- the first mutation attempt tried `write_file(index.html)` and hit artifact guard before succeeding on the next attempt;
- `nextToolCall` remained `none` throughout.

Interpretation:
- Refactor flow is improved, but deterministic continuation is still weak.

### I. Consistency validation rule is currently wrong for this task type
At the end of the separation task, a critical consistency check fires:
- `package.json: TypeScript/JavaScript files were written but no package.json exists in the workspace root.`

Interpretation:
- This rule is over-broad and incorrect for static web assets.
- Plain `index.html + styles.css + script.js` does **not** require `package.json`.

## Findings from codebase review

### 1. Task classification has improved
`TaskClassifier` now routes creation requests in `greenfield` or `docs_only` workspaces to `single_file_creation` when the user names one file or asks for a simple app/tool like a clock or calculator. This is a real fix and aligns with the successful first paint-app creation run.

### 2. Template design is much better than before
`TaskTemplate` now includes `single_file_creation` with:
- `requiresBatch=false`
- `allowDiscovery=false`
- `maxWholeFileReads=0`
- explicit stop rules: write exactly the requested file, no extra files, no discovery.

This is directionally correct.

### 3. Batch enforcement is conceptually cleaner
`BatchEnforcer` now clearly states that batch enforcement is driven by the active task template, not by workspace type. Workspace type only influences template selection. This reduces previous contradictions.

### 4. Execution state model is capable enough, but underused
`ExecutionStateManager` has the right shape:
- `primaryObjective`
- `resumeNote`
- `resolvedInputs`
- `resolvedInputContents`
- `artifactsCreated`
- `nextActions`
- `nextToolCall`
- compact context packet support

The problem is not lack of data model. The problem is that the runtime still leaves `nextToolCall` unset in situations where it should be mandatory.

### 5. Recovery coverage is still incomplete
`RecoveryManager` has meaningful triggers, including `MISSING_NEXT_ACTION`, but the log demonstrates missing categories such as:
- repeated same-file rewrites with no net progress,
- repeated unavailable-tool routing,
- repeated invalid shell-command attempts for the host platform,
- successful-completion-not-terminated.

## Root causes

### Root cause 1 — completion state is not authoritative enough
After a successful single-file creation, the run does not transition decisively into:
- `WAITING_FOR_USER_INPUT`, or
- `COMPLETED`.

Instead, the state still carries a mutation instruction and the next session resumes as if implementation is incomplete.

### Root cause 2 — `nextToolCall` is still missing on the main path
The state repeatedly shows:
- valid objective,
- known artifact path,
- known mutate phase,
- but `nextToolCall: none`.

That means deterministic dispatch exists in design, but not in practice where it matters most.

### Root cause 3 — allowed tools are not filtered by actual runtime capability
The prompt advertises `edit_file` as allowed. The auto-redirect chooses `edit_file`. The MCP environment does not provide it. The system still repeats the same path.

### Root cause 4 — mutation conflict handling is not normalized
Once a file exists and is already loaded into resolved inputs, the mutation strategy should become one of:
- targeted edit using a real available edit tool,
- explicit overwrite via `write_file` with a controller-approved whole-file rewrite,
- or terminate because the file is already complete.

Currently it oscillates between these modes without a decisive branch.

### Root cause 5 — command generation is not environment-aware
The use of `ls` on a Windows-like host is a direct example. The command layer needs platform awareness or a shell abstraction.

### Root cause 6 — validation policy is too generic
The `package.json required when JS written` rule is inappropriate for static asset tasks.

## Required bug fixes

### P0 — make successful single-file completion terminate cleanly
When a `single_file_creation` template writes the requested file successfully and there are no outstanding blockers, the controller must set one of:
- `runPhase = WAITING_FOR_USER_INPUT`, or
- `runPhase = COMPLETED`

And it must clear mutation-oriented `nextActions` / `nextToolCall`.

Implementation requirements:
- add explicit post-write completion rule for `single_file_creation`;
- do not resume with “Write the requested file now” after the file has already been written successfully;
- final model text should not imply further implementation is pending.

### P0 — populate `nextToolCall` whenever the next legal action is already known
Mandatory cases:
- after single-file classification before the first mutation;
- after a successful discovery step that resolves the only relevant file;
- after artifact guard auto-load when the system decides the next move is overwrite or edit;
- after batch declaration when the next remaining file is known.

Target behavior:
- the runner should skip unnecessary LLM deliberation for obvious next actions.

### P0 — never advertise or auto-redirect to unavailable tools
Before exposing `Allowed tools:` in the step contract, intersect the ideal tool set with the actual MCP capability set.

Required changes:
- capability-aware allowed-tool computation;
- if `edit_file` is unavailable, do not mention it in the step contract;
- do not auto-redirect `write_file → edit_file` unless `edit_file` is confirmed available;
- choose a fallback path deterministically, e.g. approved whole-file rewrite via `write_file`.

### P0 — add repeated-same-file-mutation loop detection
New recovery trigger needed when all of the following hold for N >= 2 consecutive steps:
- same target file,
- same tool family (`write_file` / unavailable redirected edit),
- no new files created,
- no verification performed,
- no material state transition.

Recovery action should be one of:
- stop and report already complete;
- force a verification step;
- or force a deterministic overwrite/edit path.

### P1 — make shell commands platform-aware or avoid them entirely when state is sufficient
Fixes required:
- detect host shell/platform and use correct command syntax;
- or prohibit shell inspection commands when the artifact registry and execution state already provide the needed file existence information.

For this log, `ls -lh index.html` should never have been selected.

### P1 — normalize mutation strategy after artifact guard conflict
When `write_file(path)` hits an existing file and the file is auto-loaded:
- set `resolvedInputs[path]` and `resolvedInputContents[path]` as authoritative;
- compute one concrete next path:
  - `edit_file` if available,
  - else `replace_range` / `multi_edit` if available,
  - else `write_file` overwrite with explicit controller approval.
- set `nextToolCall` to that concrete action.

Do not return to free-form planning text.

### P1 — remove stale next actions after state change
The log repeatedly preserved:
- `Write the requested file now. Generate the full content directly.`

This remained even after the file had already been written.

Required fix:
- recompute `nextActions` after every successful mutation;
- invalidate stale action text on phase transitions;
- do not carry forward first-turn actions into post-write mutation rounds.

### P1 — reduce unnecessary discovery in refactor flows
For the split request, `list_files` added little value because the artifact registry already knew `index.html` existed.

Improve targeted patch behavior:
- if artifact registry already contains the obvious target file and user intent references that artifact implicitly, prefer direct `read_file(index.html)` over `list_files(.)`.

### P1 — fix validation rule for static web tasks
The consistency rule that flags missing `package.json` after writing JavaScript is wrong for plain browser JS.

Replace with a scoped rule set:
- require `package.json` only for Node/npm-style projects or when imports/build tooling imply it;
- do not flag standalone `index.html + styles.css + script.js` outputs.

## Enhancements

### E1 — introduce completion verification for small artifacts
For single-file creation and small refactors, perform a lightweight verification step after write:
- syntax sanity check where possible;
- file-size / truncation guard;
- optional browser/static validation if available.

This is especially important because the model in the log kept claiming the file was cut off or incomplete without any formal verification.

### E2 — add a true controller-first mutation branch
Current behavior is still “controller hints + LLM chooses.”

Move to:
- controller decides phase,
- controller decides permitted tool set from actual capabilities,
- controller sets `nextToolCall` whenever the next move is obvious,
- LLM only generates content or edit payload.

### E3 — add objective-shape memory across follow-up turns
The follow-up request `ok separate html from js and css` was correctly interpreted as modifying the existing paint app, but this depended on discovery.

Enhancement:
- carry forward the last completed artifact bundle as a structured task result;
- on follow-up refactor requests, use that artifact bundle directly as starting context.

### E4 — improve session health scoring
The log shows `Session health: 100/100` even when the run was clearly wasting turns and retrying an unavailable tool path.

Health scoring should penalize:
- repeated same-file rewrites,
- unavailable-tool loops,
- invalid shell commands,
- excessive turns without phase transition,
- lack of verification after repeated mutations.

## Required tests

### Unit tests
1. `single_file_creation` writes once and terminates.
2. successful first write clears mutation `nextActions`.
3. `nextToolCall` is populated for first-turn single-file creation.
4. artifact guard conflict chooses only tools that actually exist.
5. repeated unavailable-tool redirects trigger recovery.
6. repeated same-file rewrite attempts trigger loop detection.
7. static web split (`index.html` → `index.html + styles.css + script.js`) does not require `package.json`.
8. targeted patch prefers known artifact over `list_files` when artifact registry already contains the only likely target.

### Integration tests
1. Prompt: “make me a simple paint brush app, functional but small and simple”
   - expect one successful write,
   - no discovery,
   - no second mutation round,
   - terminal/wait state reached.

2. Resume after successful single-file write
   - expect no `run_command` inspection,
   - expect either completion acknowledgment or targeted edit only if the user requests a change.

3. Follow-up: “ok separate html from js and css”
   - expect direct read of `index.html` or equivalent resolved input usage,
   - write `index.html`, `styles.css`, `script.js`,
   - no false `package.json` critical error.

4. Runtime without `edit_file` MCP support
   - expect no prompt contract listing `edit_file`,
   - no auto-redirect to unavailable tool,
   - deterministic fallback path chosen.

5. Windows shell host
   - expect no `ls` command generation.

## Suggested implementation order

1. Fix post-write completion transition for `single_file_creation`.
2. Make `nextToolCall` mandatory on controller-known paths.
3. Make allowed-tool contracts capability-aware.
4. Remove auto-redirect to unavailable tools.
5. Add repeated same-target mutation loop detection.
6. Fix static-web validation rule.
7. Add platform-aware shell command abstraction.
8. Improve health scoring and verification.

## Acceptance criteria

This work is complete when all of the following are true:
- a single-file creation request writes once and stops cleanly;
- no resumed run asks to write the same completed file again unless the user requested a change;
- no step contract advertises tools missing from MCP runtime;
- no repeated rewrite loop occurs on an already written file;
- no `ls`-style Unix commands are emitted on Windows hosts;
- splitting a static HTML app into HTML/CSS/JS files succeeds without false `package.json` errors;
- logs show at least one `deterministicDispatch` on controller-known next steps;
- session health meaningfully degrades when loops or unavailable tools occur.

## Final assessment

The architecture is now much closer to correct than before. The old catastrophic misclassification/discovery problem has largely been fixed. The remaining problem is different: **the controller still does not assert authority strongly enough after a successful write or a known conflict**. The next engineering phase should focus on decisive state transitions, capability-aware tool routing, and loop prevention on mutation paths.
