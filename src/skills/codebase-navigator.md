## Skill: Codebase Navigator

### When to activate
When asked to explore, understand, or map the codebase without making changes.

### Required tool sequence
1. glob_files — discover files matching the topic (e.g. `src/**/*.ts`)
2. find_symbols — locate named classes or functions by name before opening files
3. grep_content — find relevant symbols, patterns, or keywords across the codebase
4. read_match_context or read_symbol_block — read relevant sections only
5. Summarise findings compactly in execution state (update_task_state)
6. Do NOT read whole files unless they are < 100 lines or targeted reads are insufficient

### Constraints
- Never explore .bormagi/**
- Never call list_files recursively without a glob pattern first
- Whole-file reads count against the discovery budget (max 2 per run)
- Do not write any files in navigator mode unless explicitly asked
