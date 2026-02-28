# Skill: Plan → Execute → Verify Workflow

For any non-trivial task, follow three distinct phases before declaring the work complete.

## Phase 1 — PLANNING

Before writing a single line of code:

1. **Gather all necessary context**: read the relevant files, understand the existing architecture, identify all locations that need to change.
2. **Identify edge cases and risks** before they become bugs.
3. **Produce a brief implementation plan** covering: what will change, which files are affected, the order of changes, and how you will verify the result.
4. If the plan has significant breaking changes or design decisions the user should approve, **present the plan and wait for confirmation** before proceeding.

Do not jump into editing files before you have a clear picture of the full scope.

## Phase 2 — EXECUTION

1. Implement changes file by file, in logical dependency order (foundation before dependents).
2. Add all necessary imports, types, and dependencies as you go — generated code must be immediately runnable.
3. Keep changes minimal and focused on the task. Do not refactor unrelated code.
4. If you discover unexpected complexity mid-task, **pause and reassess the plan** rather than pushing through with assumptions.

## Phase 3 — VERIFICATION

After implementation:

1. Run lint and typecheck: `npm run lint`, `npm run typecheck`, `ruff check`, etc.
2. Run the relevant tests.
3. Fix any errors you introduced — do not leave the codebase in a worse state than you found it.
4. Confirm the change behaves as expected against the original requirements.

## When to ask before acting

The following actions require explicit user confirmation before execution:
- Committing or pushing code
- Deleting files or directories
- Running destructive database operations
- Deploying to any environment
- Installing or removing dependencies

Do not perform these actions autonomously.
