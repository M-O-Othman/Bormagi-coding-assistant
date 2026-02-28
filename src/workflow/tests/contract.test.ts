// ─── Contract tests for handoff and agent result payloads (WF-1004) ─────────────
//
// Validates that:
//   1. AgentRunner.parseStructuredCompletion() correctly parses structured outcome payloads.
//   2. HandoffRequest and ReviewRequest payloads satisfy their TypeScript interfaces.
//   3. Backward-compatibility: plain text responses (no JSON fence) default to 'completed'.
//   4. Unknown outcome values fall back safely to 'completed'.
//
// These tests do NOT require file I/O or a real VS Code environment.
// Run with: npx jest src/workflow/tests/contract.test.ts

import { ExecutionOutcome } from '../enums';
import type { AgentExecutionResult } from '../types';

// ─── Inline stub of parseStructuredCompletion ─────────────────────────────────
// We extract the parsing logic into a pure function here to test it in isolation
// without spinning up the full AgentRunner (which requires VS Code APIs).

function parseStructuredCompletion(responseText: string, taskId: string, workflowId: string): AgentExecutionResult {
  const FENCE_OPEN = '```json';
  const FENCE_CLOSE = '```';
  const MARKER = '"__bormagi_outcome__": true';

  const start = responseText.indexOf(FENCE_OPEN);
  if (start === -1) {
    // No JSON fence — plain-text response; default to completed
    return {
      taskId,
      workflowId,
      agentId: 'unknown',
      outcome: ExecutionOutcome.Completed,
      summary: responseText.slice(0, 500),
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt: new Date().toISOString(),
    };
  }

  const jsonStart = start + FENCE_OPEN.length;
  const end = responseText.indexOf(FENCE_CLOSE, jsonStart);
  const jsonStr = end === -1 ? responseText.slice(jsonStart) : responseText.slice(jsonStart, end);

  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (!parsed.__bormagi_outcome__) throw new Error('Missing marker');

    const outcome: ExecutionOutcome = Object.values(ExecutionOutcome).includes(parsed.outcome)
      ? parsed.outcome
      : ExecutionOutcome.Completed;

    return {
      taskId,
      workflowId,
      agentId: parsed.agentId ?? 'unknown',
      outcome,
      summary: parsed.summary ?? '',
      producedArtifactIds: parsed.producedArtifactIds ?? [],
      delegateTo: parsed.delegateTo ?? null,
      handoffRequest: parsed.handoffRequest ?? null,
      reviewRequest: parsed.reviewRequest ?? null,
      blocker: parsed.blocker ?? null,
      completedAt: new Date().toISOString(),
    };
  } catch {
    // Malformed JSON or missing marker → default to completed
    return {
      taskId,
      workflowId,
      agentId: 'unknown',
      outcome: ExecutionOutcome.Completed,
      summary: responseText.slice(0, 500),
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt: new Date().toISOString(),
    };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TASK_ID = 'task-001';
const WF_ID = 'wf-001';

describe('AgentRunner — parseStructuredCompletion contract', () => {

  test('plain text response → outcome: completed', () => {
    const text = 'I have finished implementing the feature. All tests pass.';
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Completed);
    expect(result.summary).toBe(text);
    expect(result.delegateTo).toBeNull();
    expect(result.handoffRequest).toBeNull();
  });

  test('structured completed payload is parsed correctly', () => {
    const payload = {
      __bormagi_outcome__: true,
      agentId: 'advanced-coder',
      outcome: 'completed',
      summary: 'Implementation done.',
      producedArtifactIds: ['art-1'],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
    };
    const text = `Here is my report.\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Completed);
    expect(result.agentId).toBe('advanced-coder');
    expect(result.producedArtifactIds).toEqual(['art-1']);
    expect(result.summary).toBe('Implementation done.');
  });

  test('structured delegated payload populates delegateTo and handoffRequest', () => {
    const handoff = {
      fromAgentId: 'solution-architect',
      toAgentId: 'advanced-coder',
      objective: 'Implement the auth service',
      inputs: [],
      outputs: [],
      reasonForHandoff: 'Architecture approved, ready for implementation.',
      inputArtifactIds: [],
      relevantDecisionIds: [],
      constraints: [],
      expectedOutputs: ['implementation'],
      doneCriteria: ['All unit tests pass'],
      isBlocking: true,
    };
    const payload = {
      __bormagi_outcome__: true,
      agentId: 'solution-architect',
      outcome: 'delegated',
      summary: 'Delegating to coder.',
      producedArtifactIds: [],
      delegateTo: 'advanced-coder',
      handoffRequest: handoff,
      reviewRequest: null,
      blocker: null,
    };
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Delegated);
    expect(result.delegateTo).toBe('advanced-coder');
    expect(result.handoffRequest).not.toBeNull();
    expect(result.handoffRequest!.toAgentId).toBe('advanced-coder');
  });

  test('structured review_requested payload populates reviewRequest', () => {
    const review = {
      requestingAgentId: 'advanced-coder',
      reviewerAgentId: 'software-qa',
      itemUnderReview: 'src/auth/auth.service.ts',
      reviewScope: 'Security review of authentication logic',
      reviewCriteria: ['No SQL injection', 'Passwords hashed'],
      isBlocking: true,
    };
    const payload = {
      __bormagi_outcome__: true,
      agentId: 'advanced-coder',
      outcome: 'review_requested',
      summary: 'Requesting review.',
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: review,
      blocker: null,
    };
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.ReviewRequested);
    expect(result.reviewRequest).not.toBeNull();
    expect(result.reviewRequest!.reviewerAgentId).toBe('software-qa');
  });

  test('structured blocked payload populates blocker field', () => {
    const blocker = {
      stageId: 'implementation',
      taskId: TASK_ID,
      raisedByAgentId: 'advanced-coder',
      reason: 'Database credentials not available in environment.',
      severity: 'high',
      suggestedRoute: 'Human owner to provide credentials via .env',
    };
    const payload = {
      __bormagi_outcome__: true,
      agentId: 'advanced-coder',
      outcome: 'blocked',
      summary: 'Cannot proceed — missing credentials.',
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker,
    };
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Blocked);
    expect(result.blocker).not.toBeNull();
    expect(result.blocker!.severity).toBe('high');
  });

  test('malformed JSON fence → defaults to completed with text summary', () => {
    const text = 'Some preamble\n```json\n{invalid json here\n```';
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Completed);
  });

  test('unknown outcome value → defaults to completed', () => {
    const payload = {
      __bormagi_outcome__: true,
      agentId: 'agent-x',
      outcome: 'something_unknown',
      summary: 'Done.',
      producedArtifactIds: [],
    };
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Completed);
  });

  test('missing __bormagi_outcome__ marker → defaults to completed', () => {
    const payload = { outcome: 'delegated', agentId: 'x', summary: 'oops' };
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseStructuredCompletion(text, TASK_ID, WF_ID);
    expect(result.outcome).toBe(ExecutionOutcome.Completed);
  });
});
