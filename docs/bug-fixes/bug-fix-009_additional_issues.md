# Bormagi Advanced Coder — Additional Issues Not Fully Covered by bug-fix-008

**Date:** 2026-03-19  
**Purpose:** Delta report against `bug-fix-008_details.md` based on the fresh post-revert log and screen dump.

---

## Conclusion

**Yes.** The fresh run reveals several issues that are **not fully covered** in `bug-fix-008_details.md`, even though there is major overlap.

### Already covered in bug-fix-008
The existing document already covers these core problems:

- wrong template selection for requirements-driven implementation
- READY vs DISCOVER contradiction
- missing persistent implementation queue / missing `nextToolCall`
- premature pausing after one write
- diagnostic turns mutating the workspace
- stale / fabricated session summaries driven by model narrative instead of ledger

Those remain valid and are still failing in the latest run.

### Newly observed or insufficiently specified issues
The fresh log adds several **new or more concrete defects** that should be tracked separately:

1. **Platform-incompatible command generation on Windows**
2. **Controller still uses shell discovery even when READY/preloaded spec already exists**
3. **Runtime attempts to read internal `.bormagi` logs during normal user conversations**
4. **`update_task_state` still consumes progress budget without real implementation progress**
5. **Objective corruption on explanatory turns**
6. **Session summary still fabricates the entire project type/domain, not just file list**
7. **Write target drift (`backend/requirements.txt` / root `requirements.txt`) instead of controller-owned artifact plan**

---

## 1. Delta analysis versus bug-fix-008

## 1.1 Issue already covered: wrong template
Fresh log still shows:

- `Pre-loaded requirements.md`
- workspace effectively documentation-only
- runtime still starts as `template=existing_project_patch`

This is already addressed by bug-fix-008 under **requirements_driven_build** and classifier changes.

## 1.2 Issue already covered: READY not authoritative
Fresh log still shows preloaded `requirements.md`, but the agent performs:

- `list_files`
- `run_command`
- only then a write

This is already covered by bug-fix-008 under **READY must hard-block discovery**.

## 1.3 New issue: platform-specific command generation is still broken
The fresh run uses:

```text
find . -type f -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "*.json" -o -name "package.json" -o -name "requirements.txt" | head -20
```

and gets:

```text
'head' is not recognized as an internal or external command
```

This is **not explicitly covered** in bug-fix-008. The previous plan says discovery should be avoided, but it does not add a concrete **platform-aware command selection layer**.

### Required fix
Add a command portability layer or, preferably, ban shell discovery for controller-owned cases.

```ts
// src/tools/CommandBuilder.ts
export type HostPlatform = 'windows' | 'posix';

export function detectHostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'windows' : 'posix';
}

export function buildListSourceFilesCommand(platform: HostPlatform): string {
  if (platform === 'windows') {
    return 'dir /s /b *.py *.js *.ts *.json requirements.txt package.json';
  }

  return 'find . -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "*.json" -o -name "requirements.txt" -o -name "package.json" \) | head -20';
}
```

### Acceptance criteria
- No `head`, `mkdir -p`, or Unix-only shell syntax on Windows.
- If READY/preloaded inputs exist, shell discovery should be skipped entirely.

---

## 1.4 New issue: internal `.bormagi` logs are being read during normal interaction
In the fresh log, when the user asks:

```text
what made you stop?
```

the runtime attempts:

```text
read_file .bormagi/logs/advanced-coder.log
```

That should never happen in normal user mode. Internal controller logs are framework state, not project input.

This is **not explicitly covered** in bug-fix-008.

### Required fix
Disallow internal framework paths as discovery candidates unless an explicit internal-debug mode is enabled.

```ts
// src/agents/PathPolicy.ts
const INTERNAL_RUNTIME_PATHS = [
  /^\.bormagi\//i,
  /^\.git\//i,
];

export function isInternalRuntimePath(path: string): boolean {
  return INTERNAL_RUNTIME_PATHS.some(rx => rx.test(path.replace(/\\/g, '/')));
}

export function canAgentReadPath(path: string, mode: 'normal' | 'internal_debug'): boolean {
  if (mode === 'internal_debug') return true;
  return !isInternalRuntimePath(path);
}
```

### Acceptance criteria
- `.bormagi/**` is unreadable in normal coding mode.
- Diagnostic questions must be answered from execution state, not by reading internal logs.

---

## 1.5 New issue: `update_task_state` is still being treated like productive progress
In the fresh log, the runtime repeatedly reaches:

- `update_task_state`
- efficiency/progress guard halts
- no meaningful implementation writes occurred

This indicates the runtime still allows bookkeeping actions to consume the limited iteration budget during a write-now phase.

Bug-fix-008 mentions queueing and stop reasons, but does **not explicitly forbid** `update_task_state` from counting as progress.

### Required fix
Redefine progress accounting.

```ts
// src/agents/ProgressGuard.ts
export type ProgressEventType =
  | 'write_success'
  | 'edit_success'
  | 'verification_success'
  | 'bookkeeping_only'
  | 'discovery_only'
  | 'error';

export function countsAsMaterialProgress(type: ProgressEventType): boolean {
  return (
    type === 'write_success' ||
    type === 'edit_success' ||
    type === 'verification_success'
  );
}
```

```ts
// src/agents/AgentRunner.ts
if (lastTool === 'update_task_state') {
  markProgressEvent('bookkeeping_only');
}
```

### Acceptance criteria
- `update_task_state` never resets or satisfies the non-progress guard by itself.
- In mutate phases, bookkeeping cannot substitute for code creation.

---

## 1.6 New issue: explanatory turns still corrupt the primary objective
The fresh run shows the runtime using user questions like:

- `what made you stop?`
- `what do you want from me ?`

as if they were the active task objective for a new code run.

Bug-fix-008 covers **diagnostic turns should not mutate**, but it does **not explicitly require preserving the original primary objective unchanged** across those turns.

### Required fix
Store a long-lived task objective and a separate per-turn conversational intent.

```ts
// src/agents/ExecutionStateManager.ts
export interface ExecutionState {
  primaryObjective: string;
  activeUserTurnIntent?: 'continue_task' | 'diagnostic_question' | 'status_question' | 'modify_scope' | 'new_task';
  lastNonMutatingAnswer?: string;
}
```

```ts
// src/agents/AgentRunner.ts
if (turnIntent === 'diagnostic_question' || turnIntent === 'status_question') {
  return answerFromState({
    preservePrimaryObjective: true,
    mutateWorkspace: false,
  });
}
```

### Acceptance criteria
- Asking “why did you stop?” must not replace the main build objective.
- A subsequent `continue` resumes the original build plan.

---

## 1.7 New issue: summary fabricates the entire solution domain, not just files
The fresh session writes only `backend/requirements.txt`, but the summary claims the system is:

- a **real-time collaborative document editor**
- with **WebSockets**
- **React frontend**
- **JWT authentication**
- **Redis**
- **Monaco editor**
- **Docker**
- and more

This is worse than the file-list mismatch covered in bug-fix-008. It means the synthesis layer is inventing the **entire project identity**, not merely extra changed files.

### Required fix
Forbid free-form architecture claims unless supported by actual ledger evidence or resolved requirement content.

```ts
// src/agents/SynthesisGuard.ts
export interface SafeSummaryEvidence {
  changedFiles: string[];
  actualTools: string[];
  resolvedInputs: string[];
  confirmedTechnologies: string[];
}

export function buildConfirmedTechnologies(
  changedFiles: string[],
  resolvedInputsText: string,
): string[] {
  const tech = new Set<string>();

  if (/fastapi/i.test(resolvedInputsText) || changedFiles.some(f => /requirements\.txt$/i.test(f))) {
    tech.add('Python backend');
  }

  if (/react/i.test(resolvedInputsText) || changedFiles.some(f => /package\.json$/i.test(f))) {
    tech.add('React frontend');
  }

  return [...tech];
}
```

### Rendering rule
- Do **not** state “implemented X” unless either:
  - a file proving X was written, or
  - the requirement text explicitly names X and the summary labels it as **planned**, not implemented.

### Acceptance criteria
- No architecture/component claims absent ledger proof.
- Separate **implemented** vs **planned** in summaries.

---

## 1.8 New issue: write target drift and artifact-plan absence remain visible
The fresh run writes `backend/requirements.txt` first, later writes root `requirements.txt`, and user-visible summaries mention entirely different paths. This suggests the runtime still does not have a stable controller-owned artifact plan.

Bug-fix-008 already proposes a queue, but the fresh log shows a new concrete symptom: **artifact target drift**.

### Required fix
Add explicit artifact-plan validation.

```ts
// src/agents/ArtifactPlanValidator.ts
export interface PlannedArtifact {
  path: string;
  purpose: string;
}

export function isWriteAllowedByPlan(path: string, plan: PlannedArtifact[]): boolean {
  return plan.some(a => a.path === path);
}
```

```ts
// src/agents/AgentRunner.ts
if (state.currentPlanId && !isWriteAllowedByPlan(toolInput.path as string, state.remainingArtifacts)) {
  throw new Error(`Write target not in controller-owned artifact plan: ${toolInput.path}`);
}
```

### Acceptance criteria
- Writes must target planned artifacts only, unless controller explicitly expands the plan.
- Session summary paths must match planned + executed artifacts.

---

## 2. Recommended new work item

Create a new work item:

**bug-fix-009 — Runtime integrity and platform-safety hardening**

Scope:
1. Platform-aware command generation
2. Ban internal `.bormagi` discovery in normal mode
3. Exclude bookkeeping from progress accounting
4. Preserve primary objective across diagnostic/status turns
5. Evidence-gated architecture summaries
6. Artifact-plan validation to prevent write target drift

---

## 3. Suggested implementation order

### Phase A — safety and correctness
1. Add path policy for `.bormagi` and other internal runtime paths
2. Add platform-aware command builder
3. Exclude `update_task_state` from material progress

### Phase B — controller integrity
4. Preserve `primaryObjective` across non-mutating turns
5. Enforce artifact-plan write validation
6. Require `nextToolCall` to target a planned artifact

### Phase C — reporting integrity
7. Add evidence-gated summary rendering
8. Split summary into `Implemented`, `Planned`, `Not yet written`

---

## 4. Definition of done

This delta is complete only when:

- Windows runs do not emit Unix-only commands
- `.bormagi/**` is never read during normal coding sessions
- `update_task_state` cannot satisfy progress guards
- “what made you stop?” and “what do you want from me?” do not mutate files and do not replace the primary objective
- session summaries cannot invent technologies or subsystems not proven by the ledger
- writes cannot drift outside the controller-owned artifact plan

---

## 5. Bottom line

`bug-fix-008_details.md` is still correct, but it is **not sufficient** for the latest failures.

The fresh run adds a second layer of defects:

- **platform safety**
- **internal-runtime boundary protection**
- **progress accounting integrity**
- **objective preservation**
- **evidence-gated synthesis**
- **artifact-plan enforcement**
