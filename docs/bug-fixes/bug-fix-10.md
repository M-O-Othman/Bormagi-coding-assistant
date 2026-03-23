## Rethinking Bormagi’s Architecture – From Patchwork to Robust System

The errors you saw (duplicate `write_file`, `mkdir -p` on Windows, etc.) are *symptoms* of a deeper architectural gap:
**the agent has no persistent understanding of its operating context** (file-system state, OS specifics, action history, or project specification).
Below is a holistic remediation plan that tackles that root problem rather than chasing individual stack-traces.

---

### 1. Introduce an **Execution Context Layer**

| Current behaviour                                                 | Desired behaviour                                                                                                                                                                                                                 | Why it matters                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Skills run *statelessly*; each tool call is decided in isolation. | A singleton `ExecutionContext` (in memory + persisted JSON) tracks:<br>• files already created/edited<br>• directories created<br>• OS & shell facts<br>• last *N* errors with hashes<br>• current high-level goal (from planner) | ⚙️ The agent can reason: “File A exists, so switch to `replace_range`” or “I’m on Windows, so don’t emit `ls`.” |

**Implementation-sketch**

```ts
// src/context/ExecutionContext.ts
export interface ExecutionContextData {
  createdFiles: Set<string>;
  os: 'win32' | 'linux' | 'darwin';
  recentErrors: string[];
  goal: string;
}

export class ExecutionContext {
  private static singleton: ExecutionContext;
  private data: ExecutionContextData;

  private constructor() { /* load from .bormagi-context.json or defaults */ }

  static get(): ExecutionContext {
    if (!this.singleton) this.singleton = new ExecutionContext();
    return this.singleton;
  }

  save() { fs.writeFile('.bormagi-context.json', JSON.stringify(this.data)); }

  // helpers like hasFile(), rememberError(), etc.
}
```

*All* skills should read/update this context—not invent ad-hoc memory.

---

### 2. Define **Semantic FS Operations** (avoid raw shell)

Encapsulate every file-system touch in an *intent-level* API:

```ts
await fsOps.ensureDir('sourcedocs');
await fsOps.writeUnique('backend/app.py', contents);
await fsOps.patchText('backend/app.py', patch);   // diff-based
```

* Under the hood, choose `fs.promises` or platform-correct shell … **without** the planner knowing.
* Coupled with `ExecutionContext`, we guarantee idempotency and cross-platform safety *for any future command*, not just `mkdir`.

---

### 3. Planner **Error-Classification & Adaptation**

Instead of naive retries, add a micro-policy engine:

```ts
if (error.includes('already written')) return adapt('switchToPatch');
if (error.includes('BLOCKED') && cmd.includes('mkdir')) return adapt('useEnsureDir');
```

*Errors fall into buckets* (contract-violation, environment, transient, logic).
The planner consults a mapping → *remediation strategy* (edit previous action, call different skill, escalate to human).

---

### 4. Explicit **Spec/Design Source of Truth**

The log shows the agent inventing files because it lacked the repo’s real spec.

* **Action:** Co-locate a machine-readable contract, e.g. `bormagi.json`:

```jsonc
{
  "packages": {
    "backend": { "entry": "main.py", "language": "python" },
    "vscode-extension": { "entry": "src/extension.ts", "language": "ts" }
  },
  "requiredDirs": ["sourcedocs", "destination"]
}
```

The planner first *parses this file* and seeds `ExecutionContext.goal`.
Now it knows exactly which files *should* exist and can plan deterministically.

---

### 5. Event-Driven **Skill Pipeline**

Swap the sequential “loop & hope” with an **observable pipeline**:

1. Planner emits *intents* → “Create backend scaffold”.
2. Skill router converts intents to concrete ops (`ensureDir`, `writeUnique`…).
3. Each op emits **events** (`DirCreated`, `FilePatched`, `ErrorThrown`).
4. `ExecutionContext` and a **Monitor** subscribe; they update state & detect loops.

> Result: infinite retries are impossible because the event stream shows repeated identical `ErrorThrown` → Monitor aborts early.

---

### 6. Cross-Platform CI Safety Net

Even with the above guardrails, regressions happen.
Add **matrix builds** (Windows & Ubuntu) that run:

```bash
pnpm bormagi-check               # validates spec vs. repo reality
pnpm bormagi-dryrun agent_test   # simulates full scaffold in sandbox mode
```

If the agent ever emits a prohibited command, the dry-run fails fast.

---

### 7. Governance & Observability

* **Structured Logs** (`jsonlines`) tagged with action-id, file, success/fail.
* **Replay tool** – feed a log back into the pipeline to reproduce or fuzz-test.
* **Metrics**: average tool-calls per scaffold, duplicate-write rate, error-bucket counts.

With data, you can iterate on policies instead of chasing anecdotes.

---

## Putting It All Together

1. **Create `ExecutionContext` & persist on every mutation.**
2. **Refactor all existing skills** to use the new FS abstraction.
3. **Embed error-classification table** in planner; one place to add new rules.
4. **Ship `bormagi.json`** so the agent never “guesses” project structure.
5. Wire CI to run a **sandbox simulation** on both major OS families.

These changes don’t just “fix `mkdir -p`”; they give the agent *situational awareness* and *self-correction* capabilities, so the next unknown error class is handled automatically.

---

### Immediate Next Steps

| Priority  | Action                                                                                   | Effort   |
| --------- | ---------------------------------------------------------------------------------------- | -------- |
| ☑️ High   | Scaffold `ExecutionContext` and replace direct `fs` in two core skills to prove concept. | 1 day    |
| ☑️ High   | Draft `bormagi.json` from current repo layout.                                           | 2 hrs    |
| ➡️ Medium | Implement error buckets & test with a forced duplicate-write.                            | 1 day    |
| ➡️ Medium | Add dry-run CI job.                                                                      | half-day |
| 🔽 Low    | Full event-stream observer + replay UI.                                                  | 2-3 days |

Once these are in, you will *never* need another hard-coded patch for platform quirks—the agent will adapt based on the context it finally understands.

---

*This is a shift from “fix the symptom” to **architect for self-awareness and adaptability**—the real root-cause remedy.*
