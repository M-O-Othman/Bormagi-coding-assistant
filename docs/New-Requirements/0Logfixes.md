Here is the fix plan I would implement, in order, with concrete behavior changes.

## 1. Make execution state authoritative and mutable

Right now the runner injects state as prompt text, but it is not the source of truth. The strongest symptoms are static or stale values like `Iterations used so far` and contradictory resume content versus actual executed actions.

### What to change

Persist a task-state object outside the prompt and update it after every tool result.

Use a structure like:

```json
{
  "task_id": "advanced-coder:tmp:phase1",
  "mode": "code",
  "workspace_state": "greenfield",
  "iterations_used": 4,
  "files_read": [
    "accounting_system_design_document.md",
    "Accounting inital plan of phases.md"
  ],
  "files_created": [
    "package.json",
    "tsconfig.json",
    "src/main.ts",
    "src/app.module.ts"
  ],
  "batch": {
    "declared": true,
    "total_files": 47,
    "completed_files": 4,
    "remaining_files": [
      "src/config/configuration.ts",
      "src/common/constants.ts"
    ]
  },
  "next_action": {
    "type": "write_file",
    "path": "src/config/configuration.ts"
  },
  "last_executed_action": {
    "type": "write_file",
    "path": "src/app.module.ts"
  }
}
```

### Runtime rule

Never derive state from assistant text. Only derive state from:

* user messages
* successful tool calls
* explicit framework transitions

### Prompt rule

Pass only a compact summary generated from this object, not the raw transcript.

---

## 2. Stop placing tool results in the user channel

You still have lines like `<tool_result name="read_file">` inside the user stream. That is still wrong.

### What to change

Use separate internal message classes:

* `assistant_message`
* `tool_call`
* `tool_result`
* `state_update`

The model should receive either:

* native tool messages if your provider supports them, or
* a compact system block like:

```text
TOOL RESULT
name: read_file
path: accounting_system_design_document.md
status: success
summary: Design document loaded successfully.
```

### What not to do

Do not serialize tool results as:

* fake user content
* XML-looking user content
* chat transcript lines

---

## 3. Do not persist speculative assistant actions as completed work

The log shows assistant text like `[write_file: src/index.ts (133 chars)]` before the actual tool execution path, and that text then contaminates resume context.

### What to change

Introduce a strict distinction:

* **planned action**
* **executed action**
* **persisted artifact**

Only executed tool results can update:

* artifact registry
* files created
* next resume point

### Guard

If a tool call did not actually happen, nothing from that assistant text is allowed into state.

Pseudo-check:

```ts
if (event.kind === "assistant_text" && looksLikeToolSyntax(event.text)) {
  discardFromState(event);
}
```

---

## 4. Enforce no-narration mode at the runner level

The user explicitly says “Do not narrate — execute immediately”, but the model still narrates.

### What to change

Add a boolean execution flag:

```json
{ "silent_execution": true }
```

When true:

* suppress assistant free-text before the next tool call
* only allow:

  * tool call
  * tool result
  * final milestone summary

### Runner behavior

If the model emits narration while `silent_execution=true`, do one of:

* strip it and continue to first tool call
* reject and reprompt internally with “tool only”

---

## 5. Turn discovery budget into a hard guard, not a suggestion

The runner already emits messages like “Stop reading — write your first file now”, but the model can ignore them.

### What to change

Track:

* consecutive reads with no writes
* repeated reads of same file
* discovery budget remaining

When the read budget is exhausted:

* block further `read_file` and `list_files`
* force transition to either:

  * `declare_file_batch`
  * `write_file`
  * `edit_file`
  * `run_validation`

Example rule:

```ts
if (state.consecutive_reads_without_write >= 3) {
  disallow(["read_file", "list_files"]);
  allowOnly(["declare_file_batch", "write_file", "edit_file"]);
}
```

---

## 6. Make the session a finite-state machine

Right now the model can drift between discovery, planning, and writing. You need explicit phases.

### Suggested FSM

* `DISCOVER_INPUTS`
* `DECIDE_ARCHITECTURE`
* `DECLARE_BATCH`
* `EXECUTE_BATCH`
* `VERIFY_BATCH`
* `RECOVER_ERRORS`
* `SUMMARISE`

### Transition example

Once both docs are read and workspace is listed:

* leave `DISCOVER_INPUTS`
* enter `DECIDE_ARCHITECTURE`

After batch declaration:

* enter `EXECUTE_BATCH`

After N writes:

* enter `VERIFY_BATCH`

The model should not be free to return to discovery unless a verification failure requires it.

---

## 7. Make batch declaration binding

You now have batching, but it is still only partly controlling execution. The log shows declared batch progress, which is good, but execution still mixes narration and implicit tool syntax.

### What to change

When a batch is declared:

* store the exact ordered file list
* only permit writes from that list
* update progress after each successful write
* disallow undeclared writes unless batch is amended

State example:

```json
{
  "batch_id": "phase1-foundation-001",
  "files": [
    "src/main.ts",
    "src/app.module.ts",
    "src/config/configuration.ts"
  ],
  "completed": [
    "src/main.ts",
    "src/app.module.ts"
  ],
  "next_required": "src/config/configuration.ts"
}
```

### Enforcement

If the next tool call is `write_file` to a path not in batch:

* reject it
* reprompt with the next required file

---

## 8. Add hard consistency checks after each batch chunk

The scaffold can drift quickly. You need small automatic validators.

The log already shows NestJS-style scaffolding and package/config setup evolving over multiple writes, so this is exactly the point where consistency checks should fire.

### Minimum validator set

After every 3–5 writes:

* each script entrypoint exists
* imports resolve to declared dependencies
* file paths referenced in batch still exist
* no duplicate package names
* tsconfig includes valid roots
* framework choice is consistent across files

### Example checks

* if `src/main.ts` imports `@nestjs/core`, then `package.json` must include NestJS dependencies
* if package main is `dist/main.js`, source entry should likely be `src/main.ts`
* if batch declares `src/config/configuration.ts`, verify it was actually written before advancing

---

## 9. Add architecture lock before first write

The plan says “NestJS/TypeScript (or Fastify)” and “Prisma or TypeORM”, so the framework must force one decision before scaffolding. 

### What to change

After reading docs, require the model to populate:

```json
{
  "backend_framework": "nestjs",
  "orm": "prisma",
  "repo_shape": "single-package",
  "queue": "bullmq",
  "storage": "s3-compatible"
}
```

Then validate every generated file against that locked choice.

### Why

This prevents mixed-framework scaffolding and reduces drift.

---

## 10. Make “already read” enforcement real

Your resume state says files already read should be skipped, but the model rereads them on continue.

### What to change

For each file in `files_read`:

* block `read_file(path)` unless:

  * file was modified since last read
  * state marks it stale
  * verification requires re-read

Pseudo-rule:

```ts
if (state.files_read.includes(path) && !state.file_changed_since_read[path]) {
  rejectTool("read_file", path, "already read and unchanged");
}
```

---

## 11. Separate internal metadata from project workspace

The agent previously drifted into `.bormagi`. That should be blocked by default.

### What to change

Introduce path classes:

* project files
* user documents
* framework metadata
* hidden internal state

Default allow list for code mode:

* project files
* user design documents

Default deny list:

* `.bormagi/**`
* internal orchestration files
* hidden control metadata

Only the runner should read framework metadata.

---

## 12. Make continue resume from `next_action`, not from transcript

The model should not decide from scratch what “continue” means.

### What to change

When user says:

* continue
* proceed
* continiue

the runner should:

1. load state
2. fetch `next_action`
3. execute it directly or ask model only for the payload needed for that exact action

Example:
If `next_action = write src/config/configuration.ts`, the next model prompt should be narrowly scoped to produce that file, not re-open the whole task.

---

## 13. Add tool protocol sanitization

The log contains assistant-visible pseudo-protocol like `[write_file: ...]`. That should never be persisted as ordinary assistant text. 

### What to change

Sanitize model output before:

* showing it to the user
* storing it in history
* using it for state updates

Strip patterns like:

* `[write_file: ...]`
* `TOOL:...`
* internal XML wrappers
* framework sentinels

Only real executed tool events should represent tool activity.

---

## 14. Add per-session health checks that can trigger recovery mode

This is no longer optional. Your runner needs self-protection.

### Metrics

Track:

* repeated read ratio
* narration-before-tool count
* blocked tool attempts
* speculative action leak count
* reads of already-read files
* divergence between artifact registry and actual executed writes

### Recovery mode trigger

If any of these exceed threshold:

* stop normal execution
* compress state
* rebuild next action from executed tools only
* resume in restricted mode

---

## 15. Add a strict milestone-based finaliser

Do not let sessions end on “about to do X”.

The session must end with exactly one of:

* milestone completed
* verification failed
* batch partially completed, with concrete persisted next action
* blocked on explicit missing input

### Required end-of-session record

```json
{
  "session_end_status": "partial_batch_complete",
  "last_successful_tool": "write_file(src/app.module.ts)",
  "next_action": "write_file(src/config/configuration.ts)",
  "narrative_tail_discarded": true
}
```

This prevents speculative carryover.

---

## Recommended implementation order

Start with these five first:

1. **authoritative mutable state**
2. **tool results out of user channel**
3. **speculative action filtering**
4. **hard no-narration + hard discovery budget**
5. **continue resumes from next_action**

Then add:

6. FSM execution phases
7. binding batch execution
8. lightweight consistency validator
9. architecture lock
10. health/recovery mode

---

## What “good” would look like on the same task

A healthy run should look like this:

1. read both docs
2. list top-level files once
3. lock architecture
4. declare file batch
5. write 3–5 files
6. validate
7. persist `next_action`
8. continue resumes at that exact next file

No repeated doc reads, no tool results in user channel, no pseudo-tool text in assistant text, no speculative actions in state.

