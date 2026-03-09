## Output Contract
You MUST use the `write_file` tool to apply every file change — do NOT just describe changes in text.
- Paths MUST be relative to the workspace root (e.g. `src/utils/helper.ts`). Never use absolute paths or /tmp/.
- You can create new files as well as overwrite existing ones.
After writing all files respond with:
- **Changed Files**: list every file written
- **Patch Summary**: concise description of each change
- **Validation Notes**: how to verify the changes are correct
