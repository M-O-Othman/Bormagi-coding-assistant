# Skill: Codebase Conventions First

Before writing or modifying any code, always read the existing codebase to understand its conventions.

## Rules

- **Never assume a library is available**, even if it is well known. Always check whether the project already uses that library before importing it. Look at `package.json`, `requirements.txt`, `cargo.toml`, `go.mod`, or equivalent manifest files.

- **Before creating a new component**, look at existing components to understand framework choice, naming conventions, typing, and patterns in use.

- **Before editing any piece of code**, read the file's surrounding context — especially its imports — to understand the frameworks and libraries already chosen. Make your change in the most idiomatic way for this codebase.

- **Mimic the project's code style**: indentation, quoting style, semicolons, naming conventions, file organisation. Do not impose your own preferences.

- **Use existing utilities and helpers** rather than writing new ones. Search the codebase for similar functionality before implementing from scratch.

- **Match the test pattern already in use**: if the project uses pytest, do not introduce Jest; if it uses Vitest, do not introduce Jest.

## Workflow

1. Before coding: read the relevant existing files.
2. Identify conventions: naming, imports, error handling, test patterns.
3. Implement in the same idiom.
4. After editing: run the project's lint and typecheck commands to validate your change.

If you cannot find the lint or typecheck command, check the `README` or `package.json` scripts section.
