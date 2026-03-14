1. Choose **Option C** for execution-layer rollout.
2. Implement the new execution path behind a **single top-level feature flag**: `executionEngineV2`.
3. Put under `executionEngineV2` all core fixes together:

   * authoritative `ExecutionStateManager`
   * tool-result isolation from user chat
   * `nextAction`-based continue/resume
   * silent-execution enforcement
   * reread blocking
   * batch enforcement
   * automatic validator invocation
4. Keep the old execution behavior temporarily available only while `executionEngineV2` is being tested.
5. Do **not** create many small feature flags for each sub-behavior unless absolutely necessary.
6. Add a second flag only if required: `validatorEnforcement`.
7. Use `validatorEnforcement` only if validator strictness may block rollout while repo drift is being cleaned up.
8. Enable `executionEngineV2` in targeted regression testing first.
9. Run regression tests covering:

   * no tool results in user chat
   * continue resumes from `nextAction`
   * reread guard works
   * silent execution suppresses narration
   * batch rules are enforced
   * validator catches obvious scaffold inconsistencies
10. Run real-session validation on:

* greenfield workspace flow
* continue/resume flow
* existing-project flow

11. If tests and real-session validation pass, make `executionEngineV2` the default path.
12. Keep the old path only for a short stabilization period.
13. Remove the old execution path after regression tests and live validation pass.
14. Remove the temporary feature flag(s) after cutover is proven stable.
15. Keep the final architecture simple: one authoritative execution path, no permanent dual-mode behavior.
