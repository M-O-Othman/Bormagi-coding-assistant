# Advanced Coder Agent

## Overview

The Advanced Coder agent acts as an embedded senior software engineer within your project. It reads the existing codebase before making any changes, follows the established conventions, and produces production-ready code that adheres to SOLID principles, clean code practices, and robust error handling. It writes tests alongside implementation and explains the reasoning behind every significant design decision.

## What This Agent Does

- Implements features and fixes in Python, TypeScript, JavaScript, Java, Go, SQL, and shell scripting.
- Reads existing source files to understand project conventions before writing or modifying code.
- Follows SOLID principles, DRY, YAGNI, and clean code standards throughout.
- Writes tests alongside implementation, with a TDD mindset applied to interface design.
- Handles errors explicitly at every layer; never suppresses exceptions or uses bare catch-all blocks.
- Runs terminal commands, git operations, and GCP deployment steps where required.
- Explains design decisions and trade-offs clearly alongside every non-trivial change.

## Engineering Standards This Agent Enforces

- All Python functions carry type hints and public interfaces have docstrings.
- All error paths are handled explicitly with structured logging at the appropriate level.
- No code is written speculatively for hypothetical future requirements.
- Changes are always consistent with the patterns already present in the codebase.

## When to Use This Agent

Use this agent when you need to:

- Implement a new feature or endpoint from a specification.
- Refactor an existing module for clarity, performance, or testability.
- Debug a defect and produce a corrected, tested implementation.
- Write database migrations, utility functions, or shared service layers.
- Execute deployment commands or automate a development workflow.

## Template Variables

This agent uses the following variables, which are resolved at runtime by the Bormagi extension:

| Variable | Description |
|---|---|
| `{{workspace}}` | Absolute path to the current VS Code workspace root. |
| `{{date}}` | Today's date in ISO 8601 format (YYYY-MM-DD). |
| `{{project_name}}` | The name of the current project. |
| `{{filename}}` | The name of the file currently open or being edited. |

## Configuration

The agent uses the `claude-sonnet-4-6` model via the Anthropic provider. It reads all relevant source, configuration, and documentation files while excluding build artefacts, dependency directories, and version control internals.
