## 1 | Problem Framing – why “fixing individual errors” can’t work

Your agent is trying to *synthesise an entire green-field project* while it:

* has **no single source of truth** for what the finished project must contain;
* treats every tool call as *stateless*, so it re-creates the same resources after every soft-reset;
* relies on **imperative shell commands** that vary across hosts;
* decides *one step at a time* without validating whether that step advances toward the overall goal;
* retries indefinitely because it can’t classify errors vs. progress.

Those gaps create the repeating patterns you keep seeing (`mkdir`, repeated `write_file`, “inconsistent state”, forced recovery, etc.).
Removing a single pattern just reveals the next one.

---

## 2 | What mature code assistants do differently

| Capability                       | Why it matters                                                              | How best-in-class tools solve it                                                                               |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Explicit Project Spec**        | Without a contract, the agent invents structure on the fly.                 | Copilot Workbench & Codestral load a `manifest.json` or `devcontainer.json` *first* and treat it as law.       |
| **Persistent Execution Context** | The agent must remember what it has already done *across* crashes/restarts. | Context is serialised after every side-effect and re-hydrated at boot (e.g. VS Code Tasks + `taskState.json`). |
| **Semantic Ops API**             | Raw shell is host-specific and non-idempotent.                              | Higher-level ops (`ensureDir`, `patchFile`) are routed to host-aware adapters.                                 |
| **Plan–Apply Loop**              | Acting token-by-token causes flailing.                                      | Generate a *plan* (dependency graph), simulate, then apply diffs.                                              |
| **Progress Sentinel**            | Need to detect livelock vs. forward motion.                                 | Compare current state to plan; abort if the delta doesn’t shrink.                                              |
| **Structured Error Taxonomy**    | Enables automatic remediation vs. escalate.                                 | Errors are bucketed (env, permission, contract, transient) and mapped to strategies.                           |

---

## 3 | Root-cause fixes for Bormagi

### 3.1 Project Contract `bormagi.project.json`

```jsonc
{
  "directories": ["backend", "frontend", "sourcedocs", "destination"],
  "entrypoints": {
    "backend": "backend/app.py",
    "frontend": "frontend/src/App.tsx"
  },
  "dependencies": {
    "python": ["fastapi", "pdfplumber"],
    "node": ["react", "axios"]
  }
}
```

* Parse it **before** any code generation.
* Fail fast if it’s missing.

---

### 3.2 Persistent Execution Context (PEC)

```ts
type PEC = {
  filesCreated: Set<string>;
  dirsCreated: Set<string>;
  hostOS: 'win32' | 'linux' | 'darwin';
  lastErrors: string[];
  planHash: string;               // SHA of current plan
};
```

* Serialise to `.bormagi/ctx.json` after **every** mutating op.
* Load it at process start *before* router/skills initialisation.

---

### 3.3 Semantic Operations Gateway

A single gateway intercepts every write or shell call:

```ts
router.on('ensureDir', fsAdapter.ensureDir);
router.on('writeFile', fsAdapter.writeOrPatch);
router.on('runShell',   shellAdapter.safeExec);
```

* `fsAdapter` selects `fs.promises` or PowerShell based on `hostOS`.
* `writeOrPatch` consults `PEC.filesCreated` to decide patch vs. create.

---

### 3.4 Plan–Apply Cycle

1. **Plan**: LLM reads the project spec + current FS snapshot and emits a *declarative* plan (JSON).
2. **Simulate**: check plan against actual files; compute diff.
3. **Apply**: gateway executes diff in topological order.
4. After each phase, measure *remaining diff*; if it doesn’t shrink → abort.

---

### 3.5 Structured Error Taxonomy

```ts
enum ErrKind { Env, Contract, Duplicate, Unknown }
function classify(e: Error): ErrKind { … }
```

* **Env** → try once on a fallback adapter, else escalate.
* **Duplicate** (`already written`) → auto-convert to patch op.
* **Contract** (missing spec) → fatal.
* Two identical **Unknown** errors in a row → stop.

---

### 3.6 Validation & CI

* `pnpm bormagi:dryrun` replicates the Plan–Apply cycle on both Windows & Linux runners.
* Fail if any raw `mkdir`, `ls`, or duplicate writes appear in the execution log.
* Store the replay logs as artefacts for inspection.

---

## 4 | Integration Steps (high-level)

1. **Spec First**
   *Author the `bormagi.project.json`; commit it.*
2. **Bootstrap PEC**

   ```bash
   npx ts-node scripts/pec-init.ts   # creates .bormagi/ctx.json
   ```
3. **Replace skill bindings with gateway**

   * In `router.ts`, route *all* FS & shell tools through the semantic adapters.
4. **Plan Engine**

   * New module `planner/plan.ts` that outputs a JSON DAG.
   * Integrate with PEC (`planHash`) to detect drifts.
5. **CI**

   * Add GitHub Actions matrix (`ubuntu-latest`, `windows-latest`) running dry-run.
6. **Deprecate old shell-based skills**

   * Remove `run_command` from the public skill list to stop the LLM from selecting it.

---

## 5 | Expected Behaviour after overhaul

* **Cold start**: agent reads spec, generates plan, creates dirs exactly *once*.
* **Crash & resume**: PEC reloads; plan step “create sourcedocs” is a no-op → progress continues.
* **Wrong command emitted**: gateway converts or blocks it; error classifier learns and planner adapts.
* **Spec change**: planHash mismatch → planner regenerates diff; applies only what changed.

No more infinite `mkdir` loops, no more duplicate writes, no more “inconsistent execution state” rebuilds.

---

## 6 | Why this fixes the *root cause*

All failures in the log are manifestations of **state blindness** and **imperative, host-specific actions**.
By introducing:

* a declared **contract**,
* a **persistent** memory of what has been done,
* an **OS-agnostic** operation layer, and
* a **plan-before-act** discipline,

the assistant now behaves like modern tooling used by GitHub-based CI pipelines or advanced IDE agents—able to reason about *where it is* in the build, detect true blockers, and move forward deterministically.
