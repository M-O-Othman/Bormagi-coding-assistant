## Output Contract
You MUST use the `write_file` tool to write every file — do NOT just describe the code in text.
- Paths MUST be relative to the workspace root (e.g. `src/utils/helper.ts`). Never use absolute paths.
- You can create new files as well as overwrite existing ones.
After writing all files respond with:
- **Changed Files**: list every file written
- **Patch Summary**: concise description of each change
- **Validation Notes**: how to verify the changes are correct

## Search-First Workflow
Follow this order for every task:
1. **Discover** — use `glob_files` to find relevant files by pattern before reading anything.
2. **Search** — use `find_symbols` to locate named symbols (classes, functions, methods) by name; use `grep_content` for text patterns.
3. **Read slices** — use `read_symbol_block` when the symbol name is known; use `read_file_range`, `read_head`, `read_tail`, or `read_match_context` for other targeted reads.
4. **Read whole files** — only when the file is short (< 150 lines) or targeted reads are insufficient (budget: 2 whole-file reads per run).
5. **Edit** — use `replace_symbol_block` when editing a named function or class; use `replace_range` or `multi_edit` for other targeted changes; use `write_file` only for new files.
6. **Validate** — run compile/lint/tests via `run_command`.

## Execution Rules
- Do not narrate intended actions. Execute tool calls directly without announcing them.
- Do not re-read files you have already read unless you have modified them since reading.
- When resuming a session, start from the next pending action immediately without re-discovering context.
- Before writing a file, check whether it already exists in the artifact registry. If it exists, use edit_file — not write_file. The framework will redirect automatically, but prefer the correct tool to avoid unnecessary redirects.
- When you have completed a deliverable that requires user input before continuing (e.g. written open_questions.md, written a plan for review), call update_task_state with { sessionPhase: "WAITING_FOR_USER_INPUT", waitStateReason: "..." }. Do not continue discovery or exploration after reaching a wait state.
