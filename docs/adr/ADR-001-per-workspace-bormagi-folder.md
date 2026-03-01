# ADR-001: Per-Workspace `.bormagi/` Configuration Folder

**Date:** 2026-01-15
**Status:** Accepted
**Deciders:** Core team

## Context

Bormagi must support multiple simultaneous VS Code windows, each pointed at a different project. Each project may have a different team, agent set, AI provider, workflow template, and audit requirements. The extension needs a predictable, isolated location to store per-project state.

Options for where to store this data include:
- Global VS Code extension storage (shared across all workspaces)
- VS Code workspace state (opaque, not inspectable by the user)
- A dot-folder within the workspace root

## Decision

Store all Bormagi project state in a `.bormagi/` folder at the workspace root. This folder contains:

```
.bormagi/
  config.json           # Project config (agents, default provider, user role)
  audit.jsonl           # Append-only audit log
  Memory.md             # Persistent agent memory
  workflows/            # Workflow instance folders
  virtual-meetings/     # Meeting transcripts and minutes
```

The folder is created on first initialisation and added to `.gitignore` automatically.

## Consequences

### Positive
- Full isolation between projects — no cross-workspace bleed.
- Files are human-inspectable with any editor.
- Easy to back up, share selectively, or delete cleanly.
- CI/CD pipelines can read config without the VS Code runtime.

### Negative / Trade-offs
- Adds a folder to the user's project repository (mitigated by `.gitignore`).
- If the user moves the workspace root, the `.bormagi/` path must move with it.
- Binary files in `.bormagi/` (e.g. generated documents) may be large.

### Neutral
- Secrets (API keys) are never written here; they go to VS Code `SecretStorage` (see ADR-002).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Global extension storage | Shared across all workspaces — no per-project isolation |
| VS Code `workspaceState` API | Opaque binary store; not user-inspectable or portable |
| User home directory (`~/.bormagi/`) | Still shared across projects unless namespaced by path hash, which is fragile |
