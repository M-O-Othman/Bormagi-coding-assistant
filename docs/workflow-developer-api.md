# Bormagi Workflow Developer API

This document describes the workflow orchestration API for developers who want to:
- Create new workflow templates
- Extend the orchestration engine
- Integrate workflow events into custom tools
- Understand the storage layout for debugging

---

> **Looking for step-by-step examples?** See [Workflow & Handoff Examples](workflow-examples.md) for
> end-to-end walkthroughs covering feature delivery, handoffs, reviews, blockers, overrides, and
> custom templates.

## Table of Contents

1. [Entity Model](#entity-model)
2. [Template Schema](#template-schema)
3. [Orchestration Service API](#orchestration-service-api)
4. [Handoff & Review APIs](#handoff--review-apis)
5. [UI Event Flow](#ui-event-flow)
6. [Storage Structure](#storage-structure)
7. [Agent Structured Completion Protocol](#agent-structured-completion-protocol)
8. [Adding a New Template](#adding-a-new-template)

---

## Entity Model

### Workflow

The top-level container. One workflow = one goal (a bug fix, a feature, a spike).

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Stable unique identifier |
| `title` | `string` | Human-readable name |
| `templateId` | `string` | ID of the template used to create this workflow |
| `status` | `WorkflowStatus` | `draft` \| `active` \| `blocked` \| `completed` \| `cancelled` |
| `humanOwner` | `string` | Person responsible for governance decisions |
| `currentStageId` | `string \| null` | Active stage (null when draft or completed) |
| `activeTaskId` | `string \| null` | The task currently holding the execution lock |
| `createdAt` | ISO-8601 | Creation timestamp |
| `updatedAt` | ISO-8601 | Last modification timestamp |

### WorkflowStage

A named phase within a workflow (e.g. "Requirements", "Implementation").

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Stable unique identifier |
| `workflowId` | `string` | Parent workflow |
| `templateStageId` | `string` | References the stage ID in the template |
| `name` | `string` | Display name |
| `status` | `StageStatus` | `pending` \| `active` \| `blocked` \| `completed` |
| `startedAt` | ISO-8601 \| null | |
| `completedAt` | ISO-8601 \| null | |

### WorkflowTask

A unit of work executed by a single agent.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Stable unique identifier |
| `workflowId` | `string` | Parent workflow |
| `stageId` | `string` | Stage this task belongs to |
| `parentTaskId` | `string \| null` | Set when this task is a child (delegated) task |
| `childTaskIds` | `string[]` | IDs of tasks spawned by this task via delegation |
| `title` | `string` | Short description |
| `objective` | `string` | Full goal statement injected into the agent's context |
| `ownerAgentId` | `string` | Agent responsible for this task |
| `status` | `TaskStatus` | `pending` \| `active` \| `waiting_review` \| `waiting_child` \| `blocked` \| `completed` \| `failed` \| `cancelled` |
| `handoffRequestId` | `string \| null` | The handoff that created this task (if delegated) |
| `notes` | `string` | Accumulates revision requests and human notes |

### Artifact

A produced output registered in the artifact registry.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | |
| `workflowId` | `string` | |
| `stageId` | `string` | Stage that produced this artifact |
| `taskId` | `string` | Task that produced this artifact |
| `producingAgentId` | `string` | |
| `name` | `string` | Human-readable name (e.g. "requirements.md") |
| `type` | `string` | Matches a `requiredOutputType` in the template |
| `path` | `string` | Workspace-relative file path |
| `version` | `number` | Starts at 1; incremented on supersede |
| `approvalStatus` | `ArtifactApprovalStatus` | `draft` \| `submitted` \| `approved` \| `rejected` \| `superseded` |

### HandoffRequest

A request for one agent to transfer a task to another.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | |
| `fromAgentId` | `string` | Delegating agent |
| `toAgentId` | `string` | Target agent |
| `objective` | `string` | The goal for the receiving agent |
| `reasonForHandoff` | `string` | Why ownership is being transferred |
| `inputArtifactIds` | `string[]` | Artifacts the receiving agent needs |
| `doneCriteria` | `string[]` | Exit conditions for the new task |
| `isBlocking` | `boolean` | Whether the parent task waits for this |
| `isApproved` | `boolean \| null` | `null` = pending human review |

---

## Template Schema

Templates are JSON files stored in `predefined-workflows/`. They define the stages, gate conditions, delegation rules, and approval checkpoints for a workflow type.

```json
{
  "id": "my-workflow",
  "name": "My Workflow",
  "description": "What this workflow is for.",
  "version": "1.0.0",
  "initialAgentId": "business-analyst",
  "initialStageId": "requirements",
  "stages": [
    {
      "id": "requirements",
      "name": "Requirements",
      "description": "Capture requirements.",
      "ownerAgentId": "business-analyst",
      "requiredInputTypes": [],
      "requiredOutputTypes": ["requirements-document"],
      "allowedTransitions": ["implementation"],
      "entryRules": [],
      "exitRules": ["requirements-document must be approved"],
      "requiresApprovalBeforeStart": false,
      "requiresApprovalBeforeComplete": true
    },
    {
      "id": "implementation",
      "name": "Implementation",
      "description": "Write the code.",
      "ownerAgentId": "advanced-coder",
      "requiredInputTypes": ["requirements-document"],
      "requiredOutputTypes": ["implementation"],
      "allowedTransitions": ["done"],
      "entryRules": [],
      "exitRules": [],
      "requiresApprovalBeforeStart": false,
      "requiresApprovalBeforeComplete": false
    },
    {
      "id": "done",
      "name": "Done",
      "description": "Workflow complete.",
      "ownerAgentId": null,
      "requiredInputTypes": [],
      "requiredOutputTypes": [],
      "allowedTransitions": [],
      "entryRules": [],
      "exitRules": [],
      "requiresApprovalBeforeStart": false,
      "requiresApprovalBeforeComplete": false
    }
  ],
  "approvalCheckpoints": [
    {
      "id": "approve-requirements",
      "triggerType": "before_completion",
      "stageId": "requirements",
      "description": "Human must approve requirements before implementation starts."
    }
  ],
  "delegationRules": {
    "business-analyst": ["advanced-coder"],
    "advanced-coder": ["software-qa"]
  },
  "metadata": {
    "estimatedDurationDays": 5,
    "complexity": "medium",
    "tags": ["example"]
  }
}
```

### Stage fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique within this template. Referenced by `initialStageId`, `allowedTransitions`, etc. |
| `ownerAgentId` | Yes | Default agent for tasks created in this stage. Can be `null` for terminal stages. |
| `requiredInputTypes` | Yes | Artifact types that must be approved before entering this stage. |
| `requiredOutputTypes` | Yes | Artifact types that must be submitted before exiting this stage. |
| `allowedTransitions` | Yes | Stage IDs that may follow this stage. Empty = terminal. |
| `requiresApprovalBeforeStart` | Yes | If `true`, blocks stage entry until a matching approval checkpoint is granted. |
| `requiresApprovalBeforeComplete` | Yes | If `true`, blocks stage completion until a matching approval checkpoint is granted. |

### Approval checkpoints

Checkpoints block stage transitions until a human grants them via the UI or `/wf-*` commands.

| Field | Values | Description |
|-------|--------|-------------|
| `triggerType` | `before_stage` \| `before_completion` | When this checkpoint must be granted |
| `stageId` | stage ID | Which stage this checkpoint governs |

### Delegation rules

The `delegationRules` map controls which agents may hand off to which other agents:

```json
"delegationRules": {
  "business-analyst": ["solution-architect", "software-qa"],
  "solution-architect": ["advanced-coder"]
}
```

- If an agent ID is absent from the map, it is unrestricted (can delegate to anyone).
- Stage-level `allowedDelegationTargetIds` (if present on a `StageTemplate`) further restricts delegation within that specific stage.

---

## Orchestration Service API

All methods are on `WorkflowEngine`. Create an instance with `createWorkflowEngine()`.

### Workflow lifecycle

```typescript
// Create a new workflow instance from a template
const { workflow, stages } = await engine.createWorkflow({
  template: myTemplate,
  title: 'Add OAuth2 login',
  humanOwner: 'alice',
  linkedIssueId: 'GH-42',           // optional
});

// Start the workflow (Draft → Active)
const started = await engine.startWorkflow(workflowId, template);

// Cancel the full workflow
await engine.cancelWorkflow(workflowId, 'No longer needed', 'alice');
```

### Task management

```typescript
// Create and immediately start a task in a stage
const task = await engine.createAndStartTask({
  workflowId,
  stageId,
  title: 'Write requirements document',
  objective: 'Full prose description of what this task must produce.',
  ownerAgentId: 'business-analyst',
  humanOwner: 'alice',
  parentTaskId: null,   // set this for child/delegated tasks
});

// Process the result of a completed agent run
await engine.processExecutionResult(workflowId, agentExecutionResult);

// Cancel a single task
await engine.cancelTask(workflowId, taskId, 'No longer needed', 'alice');

// Cancel all tasks in a stage
await engine.cancelStage(workflowId, stageId, 'Abandoned', 'alice');
```

### Blocker management

```typescript
// Raise a blocker (transitions the task to Blocked)
const blocker = await engine.raiseBlocker({
  workflowId,
  stageId,
  taskId,
  raisedByAgentId: 'advanced-coder',
  reason: 'Database credentials not configured.',
  severity: BlockerSeverity.High,    // 'low' | 'medium' | 'high' | 'critical'
  suggestedRoute: 'Human owner to provide credentials via .env',
  blockWorkflow: false,              // set true to block the whole workflow
});

// Resolve a blocker (transitions the task back to Active if no remaining blockers)
await engine.resolveBlocker(workflowId, blocker.id, 'Credentials added to .env', 'alice');

// Escalate a blocker
await engine.escalateBlocker(workflowId, blocker.id, 'alice');
```

### Return for revision

```typescript
// Ask an upstream agent to revise their work
await engine.requestRevision({
  workflowId,
  targetTaskId: 'task-001',           // task to reopen
  requestedByAgentId: 'software-qa',
  reason: 'Missing error handling in auth flow.',
  requiredChanges: ['Add try/catch to auth middleware', 'Add 401 test case'],
});
```

### Approval checkpoints

```typescript
// Grant a checkpoint (recorded with approver + timestamp)
await engine.grantApproval(workflowId, 'approve-requirements');
```

### Recovery and summary

```typescript
// On VS Code restart — recover active workflow state
const { recovered, requiresAttention } = await engine.recoverWorkflows();

// Generate a human-readable summary
const summary = await engine.generateWorkflowSummary(workflowId);
console.log(summary.markdownSummary);
```

---

## Handoff & Review APIs

### HandoffManager

```typescript
import { HandoffManager } from './workflow/Handoff';
const mgr = new HandoffManager(storage);

// Create a handoff request
const handoff = await mgr.createHandoff(workflowId, {
  fromAgentId: 'solution-architect',
  toAgentId: 'advanced-coder',
  taskId: 'task-001',
  parentTaskId: null,
  stageId: 'implementation',
  objective: 'Implement the auth service per the ADR.',
  reasonForHandoff: 'Architecture approved.',
  inputArtifactIds: ['art-001'],
  relevantDecisionIds: [],
  constraints: ['Must use bcrypt'],
  expectedOutputs: ['implementation', 'unit-tests'],
  doneCriteria: ['All tests pass', 'Coverage >= 80%'],
  isBlocking: true,
});

// Human approves or rejects the handoff
await mgr.approveHandoff(workflowId, handoff.id, 'alice', 'Looks good');
await mgr.rejectHandoff(workflowId, handoff.id, 'alice', 'Missing security review');

// Query
const pending = await mgr.listPendingHandoffs(workflowId);
```

### ReviewManager

```typescript
import { ReviewManager } from './workflow/ReviewManager';
const reviewMgr = new ReviewManager(storage);

// Request a review
const review = await reviewMgr.requestReview(workflowId, {
  taskId: 'task-002',
  requestingAgentId: 'advanced-coder',
  reviewerAgentId: 'software-qa',
  itemUnderReview: 'src/auth/auth.service.ts',
  reviewScope: 'Security review',
  reviewCriteria: ['No SQL injection', 'Passwords hashed with bcrypt'],
  isBlocking: true,
});

// Complete a review
await reviewMgr.completeReview(workflowId, review.id, 'approved', 'Looks good.');
await reviewMgr.completeReview(workflowId, review.id, 'rejected', undefined, 'Missing error handling.');
```

---

## UI Event Flow

The workflow board (`WorkflowViewProvider`) communicates with the VS Code extension host via `postMessage`.

### Webview → extension messages

| `type` | Additional fields | Description |
|--------|------------------|-------------|
| `get_board_data` | — | Refresh all Kanban column data |
| `get_workflow_detail` | `workflowId` | Load full detail for one workflow |
| `get_task_detail` | `workflowId`, `taskId` | Load full detail for one task |
| `get_artifacts` | `workflowId`, `stageId?`, `approvalStatus?` | Load artifact registry |
| `get_events` | `workflowId`, `eventType?` | Load event timeline |
| `approve_handoff` | `workflowId`, `handoffId`, `approvedBy` | Approve a pending handoff |
| `reject_handoff` | `workflowId`, `handoffId`, `rejectedBy`, `reason` | Reject a pending handoff |
| `create_workflow` | `template`, `title`, `humanOwner`, `linkedIssueId?` | Create a new workflow |
| `open_file` | `path` | Open a workspace file in the editor |

### Extension → webview messages

| `type` | `data` field | Description |
|--------|-------------|-------------|
| `board_data` | Board columns object | Full Kanban board state |
| `workflow_detail` | Workflow detail payload | |
| `task_detail` | Task detail payload | |
| `artifacts` | `Artifact[]` | Filtered artifact list |
| `events` | `WorkflowEvent[]` | Filtered event list |
| `handoff_result` | `{ success: boolean, handoff }` | Approve/reject outcome |
| `create_result` | `{ workflowId: string }` | Workflow creation result |
| `error` | `message: string` | Error description |

---

## Storage Structure

All workflow data is stored under `.bormagi/workflows/<workflow-id>/`:

```
.bormagi/
  workflows/
    <workflow-id>/
      workflow.json          — mutable workflow snapshot (overwritten on each change)
      status.json            — lightweight status snapshot
      stages.json            — mutable stage list snapshot
      artifacts.json         — mutable artifact registry
      tasks-snapshot.json    — mutable task list snapshot
      blockers.json          — mutable blocker list snapshot
      handoffs-snapshot.json — mutable handoff list snapshot
      reviews.json           — mutable review list snapshot
      tasks.jsonl            — append-only task event log
      handoffs.jsonl         — append-only handoff event log
      decisions.jsonl        — append-only decision log
      events.jsonl           — append-only workflow event log
      execution.lock         — execution lock (deleted on clean exit)
```

**JSON files** hold mutable current state. They are always valid JSON and safe to read at any time.

**JSONL files** are append-only event logs. Each line is a self-contained JSON object. Corrupt lines are skipped gracefully.

### Reading events programmatically

```typescript
const storage = new WorkflowStorage(workspaceRoot);
const events = await storage.loadEvents(workflowId);
// events: WorkflowEvent[]  — sorted by createdAt ascending
```

### Execution lock format

```json
{
  "workflowId": "abc-123",
  "taskId": "task-456",
  "agentId": "advanced-coder",
  "acquiredAt": "2026-02-28T10:00:00.000Z"
}
```

Locks older than 4 hours are treated as stale and discarded on recovery.

---

## Agent Structured Completion Protocol

Agents signal their outcome by embedding a JSON block in their final response:

````
My implementation is complete. Here is the summary of what I did...

```json
{
  "__bormagi_outcome__": true,
  "agentId": "advanced-coder",
  "outcome": "completed",
  "summary": "Implemented the auth service with JWT and bcrypt.",
  "producedArtifactIds": ["art-001", "art-002"],
  "delegateTo": null,
  "handoffRequest": null,
  "reviewRequest": null,
  "blocker": null
}
```
````

### Outcome values

| Value | Description |
|-------|-------------|
| `completed` | Task is done. No further delegation or review needed. |
| `delegated` | Agent is handing off to another agent. Populate `delegateTo` and `handoffRequest`. |
| `review_requested` | Agent wants a review before completing. Populate `reviewRequest`. |
| `blocked` | Agent cannot proceed. Populate `blocker`. |
| `failed` | Non-recoverable error. Task is marked failed. |

### Delegated example

```json
{
  "__bormagi_outcome__": true,
  "agentId": "solution-architect",
  "outcome": "delegated",
  "summary": "Architecture approved. Handing off to coder.",
  "producedArtifactIds": ["art-arch-001"],
  "delegateTo": "advanced-coder",
  "handoffRequest": {
    "fromAgentId": "solution-architect",
    "toAgentId": "advanced-coder",
    "objective": "Implement the auth service per the architecture document.",
    "reasonForHandoff": "Architecture phase complete.",
    "inputArtifactIds": ["art-arch-001"],
    "relevantDecisionIds": [],
    "constraints": ["Must use bcrypt cost factor 12"],
    "expectedOutputs": ["implementation", "unit-tests"],
    "doneCriteria": ["All unit tests pass", "Coverage >= 80%"],
    "isBlocking": true
  },
  "reviewRequest": null,
  "blocker": null
}
```

### Backward compatibility

If an agent response contains **no** `\`\`\`json` fence with `"__bormagi_outcome__": true`, the engine defaults to `outcome: "completed"` using the full response text as the summary. This ensures all existing agent prompts continue to work without modification.

---

## Adding a New Template

1. Create `predefined-workflows/<your-id>.json` using the schema above.
2. Ensure every `allowedTransitions` entry refers to a stage ID defined in `stages[]`.
3. Ensure every `requiredInputTypes` value for stage N is in the `requiredOutputTypes` of the stage that precedes it.
4. Add at least one terminal stage (empty `allowedTransitions`).
5. Test with `validateTemplate()` from `src/workflow/WorkflowTemplate.ts`:

```typescript
import { validateTemplate } from './src/workflow/WorkflowTemplate';
import myTemplate from './predefined-workflows/my-template.json';

const result = validateTemplate(myTemplate);
if (!result.isValid) {
  result.errors.forEach(e => console.error(`${e.field}: ${e.message}`));
}
```

6. In the workflow creation wizard (workflow board → "New Workflow" tab), add the template ID to the `<select>` options in `media/workflow-board.html`.
