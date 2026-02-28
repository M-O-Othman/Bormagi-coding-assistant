# Bormagi — Workflow & Handoff Examples

Hands-on walkthroughs for the most common workflow scenarios.
All examples use the built-in **Feature Delivery** template (`predefined-workflows/feature-delivery.json`).

---

## Table of Contents

1. [Creating a Workflow from the UI](#1-creating-a-workflow-from-the-ui)
2. [What Happens Inside — Stage by Stage](#2-what-happens-inside--stage-by-stage)
3. [Handoff: Architect Delegates to Coder](#3-handoff-architect-delegates-to-coder)
4. [Handoff: Coder Requests QA Review](#4-handoff-coder-requests-qa-review)
5. [Handoff Rejected — Revision Requested](#5-handoff-rejected--revision-requested)
6. [Agent Raises a Blocker](#6-agent-raises-a-blocker)
7. [Human Override — Forcing a Stage Gate](#7-human-override--forcing-a-stage-gate)
8. [Custom Template Example — API Feature (3 stages)](#8-custom-template-example--api-feature-3-stages)
9. [Chat Commands Reference](#9-chat-commands-reference)

---

## 1. Creating a Workflow from the UI

### Scenario
Your team needs to add a new "Forgot Password" feature.
You want to track it end-to-end through requirements → architecture → implementation → QA → release.

### Step 1 — Open the Workflow Board

Open the VS Code Command Palette (`Ctrl+Shift+P`) and run:

```
Bormagi: Open Workflow Board
```

Or click the workflow icon in the Bormagi sidebar.

### Step 2 — Switch to the "New Workflow" tab

Click the **New Workflow** tab at the top of the board.

Fill in the form:

| Field | Example value |
|---|---|
| Template | `Feature Delivery` |
| Title | `Add Forgot Password feature` |
| Human Owner | `alice` |
| Linked Issue | `GH-88` (optional) |

Click **Create Workflow**.

### Step 3 — What is created

The engine creates:

```
.bormagi/workflows/wf-2026-02-28-1042/
  workflow.json          — { status: "draft", currentStageId: null, ... }
  stages.json            — 7 stages: requirements, architecture, data-design, ...
  events.jsonl           — workflow_created event
```

The board switches to the **Board** view and shows one card in the **Backlog** column:

```
┌─────────────────────────────────────────────────┐
│ Add Forgot Password feature                      │
│ Stage: Requirements  •  Agent: Business Analyst  │
│ Owner: alice         •  Status: DRAFT            │
└─────────────────────────────────────────────────┘
```

### Step 4 — Start the workflow

In the Bormagi chat panel, type:

```
/wf-list
```

The bot replies with the workflow ID and a link. Then type:

```
/wf-resume wf-2026-02-28-1042
```

The workflow transitions to **Active** and creates the first task in the Requirements stage, assigned to the **Business Analyst** agent.

Alternatively, click the card on the board and press **Start** in the detail panel.

---

## 2. What Happens Inside — Stage by Stage

Once started, the workflow moves through these stages automatically as agents complete and hand off work:

```
Requirements
    ↓  (handoff: BA → Architect)
Architecture
    ↓  (handoff: Architect → Data Architect)
Data Design
    ↓  (handoff: Data Architect → Coder)
Implementation
    ↓  (handoff: Coder → QA)
QA Validation
    ↓  (approval checkpoint: pre-release)
Release Readiness
    ↓
Done
```

Each arrow represents a **handoff**: one agent signals it is done and nominates the next agent. The human approves the handoff in the board UI before the next task starts.

### Stage gates

Each stage has **required inputs** and **required outputs**:

| Stage | Requires input | Produces output |
|---|---|---|
| Requirements | — | `requirements-document` |
| Architecture | `requirements-document` | `architecture-decision-record`, `system-design-document` |
| Data Design | `architecture-decision-record` | `data-model` |
| Implementation | `requirements-document`, `system-design-document`, `data-model` | `implementation`, `unit-tests` |
| QA Validation | `implementation`, `unit-tests` | `test-report`, `qa-sign-off` |
| Release Readiness | `qa-sign-off` | `release-checklist` |

If an agent tries to complete a stage without producing the required outputs, the board shows:

```
⛔ Cannot complete stage: missing required output 'unit-tests'
```

---

## 3. Handoff: Architect Delegates to Coder

This is the most common handoff pattern. The Solution Architect has finished the design and is handing the implementation task to the Advanced Coder.

### What the agent writes

The Business Analyst / Solution Architect ends their response with a structured completion block:

````markdown
I have completed the architecture for the Forgot Password feature. The design uses a
time-limited token stored in Redis, delivered via email. See the ADR for full rationale.

```json
{
  "__bormagi_outcome__": true,
  "agentId": "solution-architect",
  "outcome": "delegated",
  "summary": "Architecture complete. ADR written at docs/adr/forgot-password.md. Delegating implementation to Advanced Coder.",
  "producedArtifactIds": ["art-adr-001", "art-design-001"],
  "delegateTo": "advanced-coder",
  "handoffRequest": {
    "fromAgentId": "solution-architect",
    "toAgentId": "advanced-coder",
    "objective": "Implement the Forgot Password feature as specified in the ADR and system design document. The feature must: (1) expose POST /auth/forgot-password accepting an email, (2) generate a cryptographically secure token (32 bytes, hex), (3) store the token in Redis with a 1-hour TTL, (4) send a reset email via the existing EmailService, (5) expose POST /auth/reset-password accepting the token and new password.",
    "reasonForHandoff": "Architecture phase complete. ADR and system design approved.",
    "inputArtifactIds": ["art-adr-001", "art-design-001"],
    "relevantDecisionIds": ["dec-001"],
    "constraints": [
      "Token must be stored in Redis — not PostgreSQL (see ADR decision #3)",
      "Password must be re-hashed with bcrypt cost factor 12",
      "The existing EmailService in src/services/email.service.ts must be used",
      "All new endpoints must be covered by integration tests using the test database"
    ],
    "expectedOutputs": ["implementation", "unit-tests"],
    "doneCriteria": [
      "POST /auth/forgot-password returns 200 for valid email, 200 (silent) for unknown email",
      "POST /auth/reset-password returns 200 on success, 400 on expired/invalid token",
      "All new tests pass with `npm test`",
      "Coverage for the new files >= 85%"
    ],
    "isBlocking": true
  },
  "reviewRequest": null,
  "blocker": null
}
```
````

### What appears in the Workflow Board

The handoff card appears in the **Detail** panel under **Pending Handoffs**:

```
┌─── PENDING HANDOFF ──────────────────────────────────────┐
│ From: Solution Architect  →  To: Advanced Coder          │
│                                                           │
│ Objective:                                                │
│   Implement the Forgot Password feature as specified...   │
│                                                           │
│ Constraints:                                              │
│   • Token must be stored in Redis — not PostgreSQL        │
│   • Password must be re-hashed with bcrypt cost 12        │
│   • Use existing EmailService                             │
│                                                           │
│ Done criteria:                                            │
│   • POST /auth/forgot-password returns 200...             │
│   • All new tests pass                                    │
│   • Coverage >= 85%                                       │
│                                                           │
│   [ ✓ Approve ]        [ ✗ Reject ]                       │
└───────────────────────────────────────────────────────────┘
```

### What the human does

**Option A — Approve:** Click **Approve**. The engine creates a child task for the Advanced Coder and releases the execution lock. The coder's task is now **Active**.

**Option B — Reject:** Click **Reject** and type a reason, e.g. *"Missing NFR about rate limiting on the forgot-password endpoint."* The architect's task is re-opened with the rejection reason appended to its notes. The architect sees:

```
[REVISION REQUESTED 2026-02-28 11:15]
Missing NFR about rate limiting on the forgot-password endpoint.
```

### What the Advanced Coder receives

When the task starts, its context includes:

```
## Workflow Context
**Workflow:** Add Forgot Password feature
**Stage:** Implementation
**Task:** Implement Forgot Password (from handoff by solution-architect)

## Handoff Details
**Objective:** Implement the Forgot Password feature...
**Constraints:**
- Token must be stored in Redis — not PostgreSQL
- Password must be re-hashed with bcrypt cost factor 12
...

## Input Artifacts
- [ADR: docs/adr/forgot-password.md](docs/adr/forgot-password.md)
- [System Design: docs/design/forgot-password.md](docs/design/forgot-password.md)

## Done Criteria
- POST /auth/forgot-password returns 200 for valid email...
```

---

## 4. Handoff: Coder Requests QA Review

Once the coder finishes implementation, it hands off to the QA agent for validation — but this is a **review** (not a full ownership transfer). The coder's task pauses while QA reviews; QA's result returns ownership to the coder.

### What the agent writes

````markdown
Implementation is complete. All unit tests pass. Requesting QA review before marking done.

```json
{
  "__bormagi_outcome__": true,
  "agentId": "advanced-coder",
  "outcome": "review_requested",
  "summary": "Implementation complete. Requesting QA sign-off.",
  "producedArtifactIds": ["art-impl-001", "art-tests-001"],
  "delegateTo": null,
  "handoffRequest": null,
  "reviewRequest": {
    "requestingAgentId": "advanced-coder",
    "reviewerAgentId": "software-qa",
    "itemUnderReview": "src/auth/forgot-password.controller.ts, src/auth/forgot-password.service.ts",
    "reviewScope": "Functional correctness, security, and test coverage of the Forgot Password implementation",
    "reviewCriteria": [
      "Token generation is cryptographically secure (crypto.randomBytes, not Math.random)",
      "Token is invalidated after single use",
      "Reset endpoint rejects expired tokens (>1 hour old)",
      "No user enumeration via different responses for known vs unknown emails",
      "Integration tests cover happy path, expired token, and invalid token cases"
    ],
    "isBlocking": true
  },
  "blocker": null
}
```
````

### Review outcome — Approved

The QA agent completes its review and the human records the result in the board:

```
Review outcome: approved_with_comments
Comments: "Implementation looks solid. Minor note: add a log entry for failed reset attempts
for audit trail. Not blocking."
```

The coder's task resumes with the QA result injected into its context. The coder can address the comment or mark the task complete.

### Review outcome — Rejected

```
Review outcome: rejected
Reason: "Token is not invalidated after use — a reset link can be used multiple times.
Must fix before release."
```

The coder's task is re-opened with the rejection reason. The coder fixes the issue and can request review again.

---

## 5. Handoff Rejected — Revision Requested

Sometimes the **receiving agent** (or the human reviewer) determines the upstream work is insufficient and sends it back.

### Scenario

The QA agent receives the implementation and discovers the requirements document is ambiguous about error handling. QA cannot write a meaningful test plan without clarification.

### What QA writes

````markdown
The requirements document does not specify the expected behaviour when the reset token
is used more than once. This is critical for the test plan. Returning to the Business
Analyst for clarification.

```json
{
  "__bormagi_outcome__": true,
  "agentId": "software-qa",
  "outcome": "delegated",
  "summary": "Returning work to Business Analyst — requirements gap found.",
  "producedArtifactIds": [],
  "delegateTo": "business-analyst",
  "handoffRequest": {
    "fromAgentId": "software-qa",
    "toAgentId": "business-analyst",
    "objective": "Clarify and update the requirements document to specify: (1) what happens if a password-reset token is used a second time, (2) what error code and message the API returns, (3) whether the user is notified by email when a reset is attempted with an expired/used token.",
    "reasonForHandoff": "Requirements gap — token reuse behaviour unspecified. Cannot write test plan without this.",
    "inputArtifactIds": [],
    "relevantDecisionIds": [],
    "constraints": [],
    "expectedOutputs": ["requirements-document"],
    "doneCriteria": [
      "requirements.md section 4.3 covers token reuse and expiry error responses",
      "Section 4.4 covers email notification on failed reset attempt"
    ],
    "isBlocking": true
  },
  "reviewRequest": null,
  "blocker": null
}
```
````

### In the Workflow Board

The board shows the BA task re-opened with a revision notice:

```
┌─── TASK: Write Requirements Document ─────────────────────┐
│ Status: ACTIVE (Revision)                                  │
│ Agent: Business Analyst                                    │
│                                                            │
│ [REVISION REQUEST 2026-02-28 14:33 — from software-qa]     │
│ Returned because: Requirements gap — token reuse           │
│ Required changes:                                          │
│   1. Specify token reuse behaviour in section 4.3          │
│   2. Specify email notification on failed reset            │
└────────────────────────────────────────────────────────────┘
```

The BA updates the requirements, re-registers the artifact, and submits a new handoff.

---

## 6. Agent Raises a Blocker

An agent hits an external dependency it cannot resolve on its own.

### Scenario

The Advanced Coder cannot proceed because the Redis instance is not configured in the local development environment.

### What the agent writes

````markdown
I cannot proceed with the implementation because `REDIS_URL` is not set and the
Redis connection fails at startup. This is required for token storage.

```json
{
  "__bormagi_outcome__": true,
  "agentId": "advanced-coder",
  "outcome": "blocked",
  "summary": "Cannot start — Redis not configured in the dev environment.",
  "producedArtifactIds": [],
  "delegateTo": null,
  "handoffRequest": null,
  "reviewRequest": null,
  "blocker": {
    "raisedByAgentId": "advanced-coder",
    "reason": "REDIS_URL environment variable is not set. The connection attempt throws ECONNREFUSED on localhost:6379. Token storage cannot proceed without a running Redis instance.",
    "severity": "high",
    "suggestedRoute": "Human owner to either: (A) start a local Redis instance with `docker run -d -p 6379:6379 redis`, or (B) add REDIS_URL to the .env.local file pointing to a staging Redis cluster.",
    "blockWorkflow": false
  }
}
```
````

### In the Board

The task moves to the **Blocked** column:

```
┌─── BLOCKER [HIGH] ────────────────────────────────────────┐
│ Raised by: Advanced Coder                                  │
│ Reason: REDIS_URL not set. ECONNREFUSED on localhost:6379  │
│                                                            │
│ Suggested route:                                           │
│   docker run -d -p 6379:6379 redis                         │
│   OR add REDIS_URL to .env.local                           │
│                                                            │
│   [ Resolve ]   [ Escalate ]                               │
└────────────────────────────────────────────────────────────┘
```

### Human resolves it

The human starts Redis locally and clicks **Resolve**, typing:

```
Started Redis via docker. Added REDIS_URL=redis://localhost:6379 to .env.local.
```

The task moves back to **Active**. The agent's next run includes the resolution note in its context.

Or via chat:

```
/wf-resume wf-2026-02-28-1042
```

---

## 7. Human Override — Forcing a Stage Gate

Sometimes you need to skip a gate (e.g. the team decides the data-design stage is not needed for this small feature).

### Via chat command

```
/wf-resume wf-2026-02-28-1042
```

When the gate check fails, the bot shows:

```
⛔ Stage gate failed for 'Implementation':
   - Missing required input: data-model (from Data Design stage)

Options:
  1. Complete the Data Design stage and produce a data-model artifact.
  2. Force the transition with /wf-resume --force and provide a reason.
```

Type:

```
/wf-resume wf-2026-02-28-1042 --force
Reason: This feature has no schema changes — the existing users table is sufficient.
       Data Design stage skipped by architecture decision (see Slack thread #eng-2026-02-28).
```

The override is logged in `events.jsonl`:

```json
{
  "type": "override_applied",
  "ts": "2026-02-28T15:02:00.000Z",
  "workflowId": "wf-2026-02-28-1042",
  "humanOwner": "alice",
  "action": "force_stage_transition",
  "targetStageId": "implementation",
  "reason": "This feature has no schema changes...",
  "overriddenCheckId": "stage-gate-data-model"
}
```

The override is visible in the **Events** tab of the workflow board with a ⚠️ badge.

---

## 8. Custom Template Example — API Feature (3 stages)

A minimal template for adding a single REST endpoint: requirements → implementation → done.

### File: `predefined-workflows/api-feature.json`

```json
{
  "id": "api-feature",
  "name": "API Feature",
  "description": "Minimal template for adding a single REST endpoint. Three stages: requirements, implementation, done.",
  "version": "1.0.0",
  "initialAgentId": "business-analyst",
  "initialStageId": "requirements",
  "stages": [
    {
      "id": "requirements",
      "name": "Requirements",
      "description": "Define the API contract: endpoint path, method, request body, response body, error cases, auth requirements.",
      "ownerAgentId": "business-analyst",
      "requiredInputTypes": [],
      "requiredOutputTypes": ["requirements-document"],
      "allowedTransitions": ["implementation"],
      "entryRules": [],
      "exitRules": ["requirements-document must be submitted"],
      "requiresApprovalBeforeStart": false,
      "requiresApprovalBeforeComplete": true
    },
    {
      "id": "implementation",
      "name": "Implementation",
      "description": "Write the endpoint, service layer, and integration tests.",
      "ownerAgentId": "advanced-coder",
      "requiredInputTypes": ["requirements-document"],
      "requiredOutputTypes": ["implementation", "unit-tests"],
      "allowedTransitions": ["done"],
      "entryRules": [],
      "exitRules": [],
      "requiresApprovalBeforeStart": false,
      "requiresApprovalBeforeComplete": false
    },
    {
      "id": "done",
      "name": "Done",
      "description": "Feature complete.",
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
      "id": "approve-api-spec",
      "triggerType": "before_completion",
      "stageId": "requirements",
      "description": "Human reviews and approves the API contract before implementation starts."
    }
  ],
  "delegationRules": {
    "business-analyst": ["advanced-coder"]
  },
  "metadata": {
    "estimatedDurationDays": 1,
    "complexity": "low",
    "tags": ["api", "quick"]
  }
}
```

### How it flows

1. **Business Analyst** writes `docs/api/post-forgot-password.md` (the API contract).
2. BA submits a handoff to `advanced-coder` (delegated outcome).
3. Human sees the handoff, approves it, and also grants the `approve-api-spec` checkpoint.
4. **Advanced Coder** implements the endpoint and writes tests.
5. Coder emits `outcome: "completed"`. Workflow moves to **Done**.

### Agent handoff for this template

BA's completion block:

```json
{
  "__bormagi_outcome__": true,
  "agentId": "business-analyst",
  "outcome": "delegated",
  "summary": "API contract written. POST /auth/forgot-password fully specified.",
  "producedArtifactIds": ["art-req-001"],
  "delegateTo": "advanced-coder",
  "handoffRequest": {
    "fromAgentId": "business-analyst",
    "toAgentId": "advanced-coder",
    "objective": "Implement POST /auth/forgot-password as documented in docs/api/post-forgot-password.md.",
    "reasonForHandoff": "API contract approved.",
    "inputArtifactIds": ["art-req-001"],
    "relevantDecisionIds": [],
    "constraints": [
      "Follow the error response format in src/utils/apiError.ts",
      "Add an integration test using the test database fixture"
    ],
    "expectedOutputs": ["implementation", "unit-tests"],
    "doneCriteria": [
      "Endpoint responds as documented for all cases in the API contract",
      "npm test passes",
      "No TypeScript errors"
    ],
    "isBlocking": true
  },
  "reviewRequest": null,
  "blocker": null
}
```

### Registering the template in the UI

Add one `<option>` to the template selector in `media/workflow-board.html`:

```html
<select id="template-sel">
  <option value="feature-delivery">Feature Delivery (7 stages)</option>
  <option value="bug-fix">Bug Fix (5 stages)</option>
  <option value="architecture-spike">Architecture Spike (4 stages)</option>
  <option value="api-feature">API Feature (3 stages)</option>  <!-- add this -->
</select>
```

---

## 9. Chat Commands Reference

All workflow operations are available via chat commands in the Bormagi chat panel.

| Command | Description | Example |
|---|---|---|
| `/wf-list` | List all workflows and their status | `/wf-list` |
| `/wf-status <id>` | Full status summary for one workflow | `/wf-status wf-2026-02-28-1042` |
| `/wf-resume <id>` | Resume a paused or blocked workflow | `/wf-resume wf-2026-02-28-1042` |
| `/wf-cancel <id>` | Cancel a workflow with a reason | `/wf-cancel wf-2026-02-28-1042` |
| `/wf-reassign <id> <taskId> <agentId>` | Reassign a task to a different agent | `/wf-reassign wf-… task-… solution-architect` |

### Example: checking status

```
/wf-status wf-2026-02-28-1042
```

Bot reply:

```
## Workflow: Add Forgot Password feature
**Status:** Active  |  **Stage:** Implementation  |  **Owner:** alice

**Active task:** Implement Forgot Password
  Agent: advanced-coder  |  Status: Active

**Completed stages:** Requirements ✓, Architecture ✓, Data Design (skipped ⚠️)

**Pending approvals:** none

**Open blockers:** none

**Recent decisions:**
  • [dec-001] Use Redis for token storage (2026-02-28)

**Missing artifacts for next stage (QA Validation):**
  • implementation — not yet produced
  • unit-tests — not yet produced
```

### Example: cancelling a task and reassigning

The coder is unavailable; reassign the active task to solution-architect temporarily:

```
/wf-reassign wf-2026-02-28-1042 task-003 solution-architect
```

Bot asks for confirmation:

```
Reassign task "Implement Forgot Password" from advanced-coder to solution-architect?
This will be logged in the audit trail. [Yes / No]
```

Type `Yes`. The task owner changes, the audit log records the override, and the workflow continues.

---

## See Also

- [Workflow Developer API](workflow-developer-api.md) — Template schema, engine API, storage structure
- [New Features](New_features.md) — Feature specification for the workflow orchestration system
- [README](../README.md) — Workflow board user guide
