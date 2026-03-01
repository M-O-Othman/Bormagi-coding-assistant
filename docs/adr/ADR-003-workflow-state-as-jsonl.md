# ADR-003: Workflow State as JSONL Append-Only Logs

**Date:** 2026-01-20
**Status:** Accepted
**Deciders:** Core team

## Context

The workflow engine must persist workflow state across VS Code restarts (crash recovery, deliberate restarts). The state includes: workflow metadata, stage transitions, task lifecycle events, handoffs, reviews, blockers, decisions, and artifact metadata.

The data access patterns are:
- **Write**: Frequent small appends (each agent action, each state transition).
- **Read-current-state**: At restart, reconstruct latest state from all events.
- **Read-history**: Audit trail — ordered chronological list of all events.
- **Replay**: Ability to replay events to recreate state at any point.

Options:
- Single mutable `workflow.json` (overwritten on each state change)
- SQLite database
- JSONL append-only event log
- JSON files per entity (one file per task, per handoff, etc.)

## Decision

Use a **dual-store** pattern:

1. **JSONL event logs** (append-only): `tasks.jsonl`, `handoffs.jsonl`, `decisions.jsonl`, `events.jsonl` — one JSON object per line. Never modified after writing. Provides the full audit trail.

2. **JSON snapshots** (mutable): `workflow.json`, `status.json`, `artifacts.json`, `handoffs-snapshot.json`, `tasks-snapshot.json`, `blockers.json`, `reviews.json` — current state for fast reads. Overwritten on each mutation.

Recovery at restart: load snapshots for current state; JSONL logs available for full audit trail.

## Consequences

### Positive
- Append-only logs are crash-safe — a failed write cannot corrupt existing events.
- Full audit trail without extra work.
- Human-readable with any text editor (`jq` friendly).
- Event replay is possible for debugging and testing.
- Corrupted lines in JSONL are skipped gracefully (one bad write does not lose all history).

### Negative / Trade-offs
- Snapshots can become stale if the extension crashes mid-write (mitigated by atomic write patterns where feasible).
- Disk usage grows over time (JSONL logs are never truncated by design).
- Recovery from severely corrupted snapshot requires replaying JSONL (not yet implemented — deferred to a future ADR).

### Neutral
- File structure lives in `.bormagi/workflows/<workflow-id>/` (see ADR-001).
- Storage layer is encapsulated in `WorkflowStorage.ts`; callers never touch files directly.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Single mutable `workflow.json` | Any crash during write can corrupt entire state |
| SQLite | Adds a native binary dependency; complicates packaging and cross-platform support |
| JSON files per entity | Too many files; no natural ordering for audit trail |
| In-memory only | Lost on every VS Code restart |
