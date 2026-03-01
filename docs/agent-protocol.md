# Bormagi Agent Protocol Contract

This document is the authoritative reference for how Bormagi agents communicate structured outcomes to the workflow orchestration engine.

---

## Overview

When an agent runs inside a workflow task (`runWithWorkflow()`), it can signal one of four outcomes by embedding a specially-marked JSON block in its response. The engine parses this block and routes the workflow accordingly.

Agents that produce no structured payload are treated as **completed** automatically — this ensures backward compatibility with plain-text agents and simpler use cases.

---

## Payload Format

The structured payload must appear inside a markdown JSON code fence in the agent's text response:

````
```json
{
  "__bormagi_outcome__": true,
  "outcome": "...",
  "summary": "...",
  ...outcome-specific fields...
}
```
````

### Required Fields (all outcomes)

| Field | Type | Description |
|-------|------|-------------|
| `__bormagi_outcome__` | `true` (literal) | Sentinel that identifies this as a Bormagi payload |
| `outcome` | `"completed"` \| `"delegated"` \| `"review_requested"` \| `"blocked"` | The outcome type |
| `summary` | string (1–2000 chars) | Human-readable summary of what was done or why stopping |

### Optional Field (all outcomes)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `producedArtifactIds` | string[] | `[]` | IDs of artifacts registered via the artifact registry during this task |

---

## Outcome Types

### `completed`

The agent finished its assigned objective with no further action required.

```json
{
  "__bormagi_outcome__": true,
  "outcome": "completed",
  "summary": "Implemented the user registration endpoint with bcrypt hashing and JWT issuance. All unit tests pass.",
  "producedArtifactIds": ["auth-service-impl"]
}
```

**Behaviour:** The workflow engine advances to the stage exit check. If all required outputs are present, the stage completes.

---

### `delegated`

The agent needs a different specialist agent to take over (or collaborate on) a sub-task.

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `toAgentId` | string | Target agent ID (must match a configured agent) |
| `objective` | string | What the receiving agent must accomplish |
| `reasonForHandoff` | string | Why this agent is handing off |

#### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `inputArtifactIds` | string[] | `[]` | Artifact IDs the receiving agent should use as inputs |
| `relevantDecisionIds` | string[] | `[]` | Decision log entry IDs relevant to the receiving agent |
| `constraints` | string[] | `[]` | Constraints the receiving agent must respect |
| `expectedOutputs` | string[] | `[]` | Deliverables expected from the receiving agent |
| `doneCriteria` | string[] | `[]` | Acceptance criteria the receiving agent should meet |
| `isBlocking` | boolean | `true` | Whether the delegating task waits for the child task |

```json
{
  "__bormagi_outcome__": true,
  "outcome": "delegated",
  "summary": "Requirements are approved. Handing off to the solution architect.",
  "toAgentId": "solution-architect",
  "objective": "Design the system architecture based on the approved requirements document.",
  "reasonForHandoff": "Requirements phase complete. Architecture decisions must now be made.",
  "inputArtifactIds": ["requirements-doc"],
  "constraints": ["Must use existing PostgreSQL cluster", "No additional cloud services without approval"],
  "expectedOutputs": ["Architecture diagram", "ADR for data store choice"],
  "doneCriteria": ["All components defined", "ADRs written and linked"],
  "isBlocking": true
}
```

**Behaviour:** The engine creates a child task owned by `toAgentId`. The parent task transitions to `waiting_child` if `isBlocking` is true. When the child completes, the parent resumes with the child's outputs in context.

---

### `review_requested`

The agent has produced work and needs a reviewer to validate it before proceeding.

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `reviewerAgentId` | string | Agent ID who should perform the review |
| `itemUnderReview` | string | Description of what is being reviewed |

#### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reviewScope` | string | `""` | Specific aspects the reviewer should focus on |
| `reviewCriteria` | string[] | `[]` | Checklist items for the reviewer |
| `isBlocking` | boolean | `true` | Whether the current task waits for review |

```json
{
  "__bormagi_outcome__": true,
  "outcome": "review_requested",
  "summary": "Implementation complete. Requesting QA review before marking the task done.",
  "reviewerAgentId": "software-qa",
  "itemUnderReview": "Auth service implementation (src/auth/)",
  "reviewScope": "Functional correctness, edge cases, and test coverage",
  "reviewCriteria": [
    "All happy-path scenarios covered by tests",
    "JWT expiry and refresh tested",
    "No SQL injection vectors"
  ],
  "isBlocking": true
}
```

**Behaviour:** The engine creates a `ReviewRequest` record. The reviewing agent runs and returns `approved`, `approved_with_comments`, or `rejected`. On rejection, the task owner receives the review notes and the task status is reset to `active`.

---

### `blocked`

The agent cannot proceed due to a missing decision, unclear requirement, or external dependency.

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `reason` | string | Explanation of why the agent cannot proceed |

#### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `severity` | `"low"` \| `"medium"` \| `"high"` \| `"critical"` | `"medium"` | Blocker severity |
| `suggestedRoute` | string | `""` | What the human owner should do to unblock |

```json
{
  "__bormagi_outcome__": true,
  "outcome": "blocked",
  "summary": "Cannot proceed with deployment configuration.",
  "reason": "The target GCP project ID and service account have not been provided. Cannot generate Terraform configuration without these.",
  "severity": "high",
  "suggestedRoute": "Provide the GCP project ID and service account email in the workspace settings, then resume this task."
}
```

**Behaviour:** The engine creates a `Blocker` record. The task transitions to `blocked`. The workflow board highlights it. A human or another agent resolves the blocker; the task then returns to `active`.

---

## Plain-Text Fallback

If an agent produces no structured payload — or if the JSON is malformed — the engine treats the response as `completed` with the first 500 characters of the response as the summary. This ensures all plain-text and legacy agents work without modification.

---

## Security: Prompt Injection Detection

Before the structured payload is used by the engine, each text field is scanned for prompt injection patterns (see `AgentRunner.INJECTION_PATTERNS`). Detected lines are stripped and the incident is logged to the audit trail (`PROMPT_INJECTION_DETECTED` event). The `offendingFields` list names which fields were affected; the actual content is never written to the log.

---

## JSON Schema

A full JSON Schema (Draft 07) is available at [`schemas/agent-completion.schema.json`](../schemas/agent-completion.schema.json). It enforces required fields per outcome type using `allOf` / `if-then` conditionals.

---

## Adding This Protocol to an Agent's System Prompt

Include the following block in the agent's system prompt (e.g. in its `system.md` file) to teach it how to signal structured outcomes:

```
## Workflow Communication

When you complete a workflow task, signal your outcome using a structured JSON block:

\`\`\`json
{
  "__bormagi_outcome__": true,
  "outcome": "completed | delegated | review_requested | blocked",
  "summary": "What you did or why you stopped.",
  ...outcome-specific fields (see agent-protocol.md)...
}
\`\`\`

If you do not include this block, the orchestrator treats your response as a plain completion.
```

---

## Implementation Reference

| Concern | File |
|---------|------|
| Payload parsing | [src/agents/AgentRunner.ts](../src/agents/AgentRunner.ts) — `parseStructuredCompletion()` |
| Injection sanitisation | [src/agents/AgentRunner.ts](../src/agents/AgentRunner.ts) — `sanitiseExecutionResult()` |
| Engine routing | [src/workflow/WorkflowEngine.ts](../src/workflow/WorkflowEngine.ts) — `processExecutionResult()` |
| Type definitions | [src/workflow/types.ts](../src/workflow/types.ts) — `AgentExecutionResult`, `HandoffRequest`, `ReviewRequest`, `Blocker` |
| Outcome enums | [src/workflow/enums.ts](../src/workflow/enums.ts) — `ExecutionOutcome` |
| Schema | [schemas/agent-completion.schema.json](../schemas/agent-completion.schema.json) |
| Contract tests | [src/workflow/tests/contract.test.ts](../src/workflow/tests/contract.test.ts) |
