## Skill: Bug Investigator

### When to activate
When investigating an error, unexpected behaviour, failing test, or regression.

### Required tool sequence
1. grep_content — search for the error string, stack trace symbol, or suspicious pattern
2. read_match_context — expand around the match location to see surrounding code
3. find_symbols — locate the failing function or class by name
4. read_symbol_block — read the exact failing function/class in full
5. Identify root cause before patching — document the cause in update_task_state
6. replace_range or replace_symbol_block for the minimal targeted patch
7. run_command to validate the fix (compile + tests)

### Constraints
- Do not patch symptoms — identify the root cause first
- Do not rewrite the entire file for a one-line fix
- Add targeted logging if cause is unclear; remove it before finishing
- Whole-file reads count against the discovery budget (max 2 per run)
