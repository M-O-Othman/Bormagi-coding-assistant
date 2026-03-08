Review the feature specification defined in the relevant file under `docs/New-Requirements/6.ai_coding_assistant_git_github_integration_spec.md` and assess the current implementation status of that feature across the codebase.

The feature might has been implemented partially and with quality issues. Your task is to evaluate it thoroughly, identify what is complete, incomplete, incorrect, missing, or implemented in a way that does not fully satisfy the specification, while ensuring that no existing working functionality is broken.
**feature-name:**6.ai_coding_assistant_git_github_integration

**Follow this process strictly:**

1. Read and understand the feature specification file fully.
2. Review the current codebase and determine the implementation status of every work item, requirement, sub-feature, dependency, and expected behavior defined in the specification.
3. Produce a detailed implementation status report and save it to a sibling file named:
   `<feature-name>_implementation_status_report.md`
4. Produce a detailed implementation and remediation plan covering:
   - missing work
   - incorrect or weak implementation
   - refactoring required
   - integration impacts
   - backward-compatibility considerations
   - required tests
   - rollout order
   Save this plan to:
   `<feature-name>_implementation_plan.md`
5. If anything is unclear, ambiguous, conflicting, underspecified, or requires a product/design decision, write all such questions into:
   `<feature-name>_open_questions.md`

Important rules:
- Do not begin implementation until I explicitly confirm that all open questions have been answered.
- Before implementation, revisit the implementation plan and update it based on the answers recorded in the open questions file.
- Only then begin implementation.
- Add all required tests, including unit tests and any other appropriate automated tests, by integrating them into the project’s existing testing structure.
- Review and update any affected project documentation, onboarding.md , help.md , README.md files, and any other related documents that should reflect the feature.
- Make only the changes required for this feature and its safe integration.
- Do not introduce unrelated refactoring or unrelated functional changes.
- Preserve existing behavior unless a change is required to satisfy the specification.
- Be careful not to break current working functionality.

Deliverables:
- `<feature-name>_implementation_status_report.md`
- `<feature-name>_implementation_plan.md`
- `<feature-name>_open_questions.md` if needed
- code changes required to correctly implement the feature
- automated tests covering the implementation
- updated documentation where relevant

Git and change-control rules:
- Commit only your own work related to this feature.
- Do not include unrelated file changes in the commit.
- Before committing, verify that the implementation aligns with the specification, the revised plan, and the answered open questions.
- Ensure tests pass before committing.

Expected quality bar:
- The status report must map each requirement/work item to its current implementation state.
- The plan must be concrete, sequenced, technically actionable, and test-aware.
- The implementation must be production-quality, coherent with the existing architecture, and consistent with project conventions.
- Where the existing implementation is weak or incorrect, explain the issue clearly and fix it systematically rather than patching symptoms.
Check for any unwired code or incomplete planned tasks /TODOs and report to user 
Push to remote github branch master