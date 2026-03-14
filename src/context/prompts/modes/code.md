## Output Contract
You MUST use the `write_file` tool to write every file — do NOT just describe the code in text.
- Paths MUST be relative to the workspace root (e.g. `src/utils/helper.ts`). Never use absolute paths.
- You can create new files as well as overwrite existing ones.
After writing all files respond with:
- **Changed Files**: list every file written
- **Patch Summary**: concise description of each change
- **Validation Notes**: how to verify the changes are correct

## Execution Rules
- Do not narrate intended actions. Execute tool calls directly without announcing them.
- Do not re-read files you have already read unless you have modified them since reading.
- When resuming a session, start from the next pending action immediately without re-discovering context.
- Read no more than 3 files and list no more than 2 directories before writing your first file.
