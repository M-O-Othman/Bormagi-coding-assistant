### What the new log reveals

The agent is **still issuing raw Unix shell commands** (`mkdir -p`, `find`, `dir`) and is **still trying to overwrite files with `write_file`** after they already exist. Two excerpts prove this:

* blocked Unix command (Windows host) 
* repeated *“`write_file REJECTED: "backend/app.py" was already written`”* loop 

These symptoms tell us the deep fixes we discussed were **not actually wired into the agent’s main execution path**.
The new utilities you wrote *exist*, but the planner/skills that the agent invokes are still the *old* ones.

---

## Root-cause map

| Symptom in log                                        | Architectural gap                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run_command "mkdir -p …"`                            | Planner still uses **raw shell skills** for FS tasks instead of the new `fsOps.ensureDir` abstraction.                                           |
| `write_file REJECTED … already written`               | `ExecutionContext.createdFiles` is *session-scoped* (resets after recovery) and not consulted by `WriteFile` skill before dispatch.              |
| “Inconsistent execution state detected — rebuilding…” | Error-monitor emits recovery but **error-classification table** has no rule for the Windows‐shell error, so the planner replays the same action. |
| Workspace stays **`docs_only`** for many turns        | `bormagi.json` (the spec we said would seed context) is missing, so scaffolder keeps guessing project layout.                                    |

---

## Fixes that must be *fully* integrated

### 1 — Bind the new File-System API at the router level

Instead of changing individual skills piecemeal, intercept **all** calls that ask the sandbox to touch the file-system:

```ts
// src/router/ToolRouter.ts
import { writeOrEdit, ensureDir } from '../utils/fsOps';

router.register('write_file', async (p) => writeOrEdit(p.path, p.content));
router.register('run_command', async (p) => {
  const cmd = p.command.trim();
  if (cmd.startsWith('mkdir')) {
    const dirs = cmd.replace(/mkdir\s+-p?\s+/i, '').split(/\s+/);
    await Promise.all(dirs.map(ensureDir));
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  // allow *non-FS* commands to pass through
  return rawShell(cmd);
});
```

*Effect*: the planner can keep emitting `run_command mkdir …` for now, but the router *rewrites* it into a safe cross-platform operation.

---

### 2 — Persist `ExecutionContext` across **recovery cycles**

Recovery restarts the Node process, so the in-memory singleton vanishes.
Serialize on every mutation and hydrate at startup:

```ts
// ExecutionContext.ts
const disk = '.bormagi/context.json';

export class ExecutionContext {
  constructor() {
    this.data = fs.existsSync(disk)
      ? JSON.parse(fs.readFileSync(disk, 'utf8'))
      : { createdFiles: [], os: process.platform, recentErrors: [], goal: '' };
  }
  flush() { fs.writeFileSync(disk, JSON.stringify(this.data)); }
}
```

Call `flush()` after **every tool handler** that mutates state.

---

### 3 — Block duplicate writes early

Enhance `writeOrEdit`:

```ts
export async function writeOrEdit(path: string, content: string) {
  const ctx = ExecutionContext.get();
  if (ctx.data.createdFiles.includes(path)) {
    // diff & patch instead of write
    return replaceRangeSmart(path, content);
  }
  // …create
  ctx.data.createdFiles.push(path);
  await fs.writeFile(path, content, 'utf8');
}
```

Now the planner never sees a “write_file rejected” error; the router silently converts it to a patch.

---

### 4 — Teach the **error-classifier** about environment errors

```ts
// ErrorClassifier.ts
const rules = [
  { pattern: /Unix command syntax "mkdir"/i, action: 'useEnsureDir' },
  { pattern: /already written this task/i, action: 'convertToPatch' },
  …
];
```

*Action handlers* mutate the queued plan before the next LLM call.

---

### 5 — Ship the project manifest (`bormagi.json`)

```jsonc
{
  "requiredDirs": ["backend", "frontend", "sourcedocs", "destination"],
  "scaffold": {
    "backend/requirements.txt": "python",
    "frontend/package.json": "json"
  }
}
```

Loader:

```ts
const spec = JSON.parse(await fs.readFile('bormagi.json', 'utf8'));
ExecutionContext.get().data.goal = spec;
```

The scaffolder can now stop guessing and create only what the spec lists.

---

### 6 — Safety net in CI

Add a test that replays an entire *agent session* and fails if:

* any `run_command` contains `mkdir`, `ls`, `find`, `rm`
* any `write_file` occurs twice on the same path
* any tool result has `exitCode != 0`

Example jest:

```ts
test('no-unix-fs-commands', () => {
  const log = JSON.parse(fs.readFileSync('last_session.json', 'utf8'));
  for (const step of log.steps) {
    expect(step.tool).not.toMatch(/unix command syntax/i);
  }
});
```

---

## Verification checklist

| Done? | Test                                     | Expected outcome                                                |
| ----- | ---------------------------------------- | --------------------------------------------------------------- |
| ☐     | `pnpm test:replay-session` on Windows    | **0** blocked commands, **0** duplicate write errors            |
| ☐     | Cold start → scaffold backend & frontend | Directories created via `ensureDir`, no shell                   |
| ☐     | Modify a file twice in one run           | Second change goes through `replaceRangeSmart`                  |
| ☐     | Trigger an unknown error                 | ErrorMonitor logs and **stops** retrying after 2 identical hits |

---

### TL;DR

Your new modules are right, but they must become *mandatory gateways*:

1. **Router layer** replaces raw FS commands with abstraction.
2. **ExecutionContext** survives across task recoveries.
3. **WriteOrEdit** promotes second writes to patches automatically.
4. **Error-classifier** learns the Windows-shell error so the planner pivots.
5. **bormagi.json** gives the agent a deterministic blueprint.

Wire these five pieces and the next log should be clear of `mkdir -p` blocks and duplicate write loops.
