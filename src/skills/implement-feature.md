## Skill: Implement Feature

### When to activate
When asked to add a new feature, function, module, or endpoint.

### Required tool sequence
1. glob_files — find related existing files by pattern
2. find_symbols — locate similar symbols to match existing conventions
3. grep_content — find import patterns, usage examples, and wiring conventions
4. read_symbol_block — read the exact relevant functions/classes (not whole files)
5. declare_file_batch if multiple new files will be created
6. replace_symbol_block or multi_edit for changes to existing files
7. write_file only for genuinely new files (no existing file at that path)
8. run_command to validate (compile, lint, tests)

### Constraints
- Do not write_file to a path that already exists — use replace_symbol_block or multi_edit
- Do not rewrite unchanged code blocks; replace only what changes
- Declare multi-file batches before writing any file
- Discovery budget applies: max 2 whole-file reads, max 12 targeted reads per run
