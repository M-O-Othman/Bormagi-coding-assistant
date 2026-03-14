# V2 Execution Engine — Live Session Verification Plan

**Phase 9.2 of agent-productivity-fixes-plan.md**

## Regression Suite Results (Phase 9.1)

- **Date run:** 2026-03-14
- **Test count:** 647 tests across 54 suites
- **Result:** ✅ All 647 pass with `executionEngineV2: true` forced globally via `src/tests/setup/v2-global-setup.ts`
- **Config:** `jest.config.js` loads `v2-global-setup.ts` via `setupFilesAfterFramework`

---

## Live Session Verification Scenarios

Three scripted manual sessions must pass before Phase 10 flips `executionEngineV2` to `true` in `package.json`.

**Setup:** Open bormagi extension dev host in VS Code (`F5`). Set `bormagi.executionEngineV2: true` in workspace settings. Use a real project workspace for all sessions.

---

### Scenario 1 — Greenfield scaffold (verifies Phase 0, 1, 3, 6)

**Goal:** Confirm that in a brand-new empty workspace the agent does not access `.bormagi/`, respects the discovery budget, declares a file batch before writing, and prompt-replay is not occurring.

**Steps:**

1. Open a new empty folder in VS Code as the workspace.
2. Switch to **Code mode**.
3. Send: `"scaffold a minimal Express TypeScript server with a health check endpoint"`
4. Let the agent run to completion (or until it stops for batch declaration).

**Pass criteria:**

| # | Check | How to verify |
|---|-------|---------------|
| 1 | No `.bormagi/` path appears in the tool-call log | Open Thought log drawer — no `read_file .bormagi/...` or `list_files .bormagi/...` calls |
| 2 | Discovery budget blocks on attempt 4+ | After 3 `read_file` calls, a subsequent `read_file` should return `[BLOCKED] ...` in the thought log |
| 3 | `declare_file_batch` called before first `write_file` | Tool call sequence in thought log: `declare_file_batch` appears before first `write_file` |
| 4 | Startup log present | First thought event contains: `[V2 RUN START]` with `mode:`, `template:`, `phase:` |
| 5 | No full prompt replay on call #2+ | Open DevTools → Network tab for provider requests; body of call #2 should have ≤ 3 messages, not the full history from call #1 |

**Expected failures:** None — all of these should pass with V2 enabled.

---

### Scenario 2 — Continue/resume (verifies Phase 2, 4)

**Goal:** Confirm that the `nextAction` field is consumed on resume, that the run does not replay full history, and that wait states stop the run.

**Steps:**

1. Use a workspace with an existing project (e.g., a small Node.js project).
2. Switch to **Code mode**.
3. Send: `"add input validation to the login handler"` — let it run 2–3 tool calls, then manually stop by closing the chat panel before the agent finishes.
4. Reopen the chat panel. Send: `"continue"`
5. Observe what the agent does.

**Pass criteria:**

| # | Check | How to verify |
|---|-------|---------------|
| 1 | Resume summary shown | Chat shows a brief message like `"Resuming from: ..."` — not a full re-run of discovery |
| 2 | No full tool replay | Thought log for the resume run starts from where it left off — does not re-read every file from scratch |
| 3 | `iterationsUsed` increments | Startup log on resume shows `iterations: N` where N > 0 (carries over) |

**Wait-state sub-test:**

1. Send: `"write an open_questions.md with questions about the auth module and wait for my answers"`
2. Let agent run.

**Pass criteria:**

| # | Check | How to verify |
|---|-------|---------------|
| 4 | Agent stops after writing `open_questions.md` | No further tool calls in the thought log after the write |
| 5 | Chat shows wait message | A message appears in the chat: something like `"Paused — waiting for your input"` |
| 6 | Agent does NOT explore `.bormagi/` after writing | Thought log has no `.bormagi/` accesses after the write |

---

### Scenario 3 — Mutation blocking and ask mode (verifies Phase 6)

**Goal:** Confirm that ask/plan modes block write operations.

**Steps:**

1. Use the same workspace as Scenario 2.
2. Switch to **Ask mode**.
3. Send: `"what does the login handler do?"`
4. Observe — agent should read files but NOT write.
5. Switch to **Plan mode**.
6. Send: `"plan how to add rate limiting to the login handler"`
7. Observe — agent should produce a plan document but NOT write any source files.

**Pass criteria:**

| # | Check | How to verify |
|---|-------|---------------|
| 1 | Ask mode: no write tool calls | Thought log has zero `write_file` or `edit_file` calls |
| 2 | Ask mode: if an attempted write appears, it shows BLOCKED | Any `write_file` attempt returns `[BLOCKED] Mode 'ask' does not permit file mutations` |
| 3 | Plan mode: write to `*.md` plan file allowed | Agent may write a plan `.md` file — this is acceptable |
| 4 | Plan mode: write to `*.ts`/`*.js` blocked | Source file writes return `[BLOCKED] Mode 'plan' does not permit file mutations` |

---

## Phase 10 Gate

Phase 10 (flip `executionEngineV2` default to `true`, remove V1 code) **must not begin** until:

- [ ] All 647 regression tests pass with V2 forced (DONE — 2026-03-14)
- [ ] Scenario 1 passes (greenfield, no `.bormagi/` access, discovery budget enforced)
- [ ] Scenario 2a passes (continue/resume from `nextAction`)
- [ ] Scenario 2b passes (wait state stops run after writing wait-keyword file)
- [ ] Scenario 3 passes (ask/plan mutation blocking)

Mark each checkbox above when the scenario passes manually. Only then proceed to Phase 10.

---

## Known Limitations Before Phase 10

The following items have test coverage but may need manual verification in live sessions:

1. **Silent mode reprompt cap** (Phase 5.2) — tested in unit tests; verify live by enabling silent mode and confirming no more than 2 reprompt nudges appear before BLOCKED state.
2. **ConsistencyValidator hot-path** (Phase 7.1) — only fires when `validatorEnforcement: true`; not enabled by default. Set `bormagi.validatorEnforcement: true` in settings to test.
3. **StepContract loop control** (Phase 2.2) — tested in unit tests; verify live that a `pause` contract stops the run loop on an iteration that has no tool calls.
