import type { AgentExecutionResult } from '../../workflow/types';
import { ExecutionOutcome } from '../../workflow/enums';
import { getAppData } from '../../data/DataStore';

type ParsedResult = Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'>;

/**
 * Sanitise a single text field from a structured completion payload.
 * Strips any line matching a known prompt injection pattern (loaded from data/security.json).
 */
export function sanitiseStructuredField(text: string): { clean: string; hadInjection: boolean } {
  const injectionPatterns = getAppData().injectionPatterns;
  const lines = text.split('\n');
  let hadInjection = false;
  const cleaned = lines.filter(line => {
    const isInjection = injectionPatterns.some(p => p.test(line));
    if (isInjection) { hadInjection = true; }
    return !isInjection;
  });
  return { clean: cleaned.join('\n').trim(), hadInjection };
}

/**
 * Sanitise all user-visible text fields of a parsed execution result.
 * Returns the cleaned result and the names of any affected fields.
 */
export function sanitiseExecutionResult(
  parsed: ParsedResult
): { result: ParsedResult; injectionFields: string[] } {
  const injectionFields: string[] = [];
  const clone = { ...parsed };

  const clean = (value: string, field: string): string => {
    const { clean: c, hadInjection } = sanitiseStructuredField(value);
    if (hadInjection) { injectionFields.push(field); }
    return c;
  };

  clone.summary = clean(parsed.summary, 'summary');

  if (clone.handoffRequest) {
    clone.handoffRequest = {
      ...clone.handoffRequest,
      objective:        clean(clone.handoffRequest.objective,        'handoffRequest.objective'),
      reasonForHandoff: clean(clone.handoffRequest.reasonForHandoff, 'handoffRequest.reasonForHandoff'),
    };
  }

  if (clone.reviewRequest) {
    clone.reviewRequest = {
      ...clone.reviewRequest,
      itemUnderReview: clean(clone.reviewRequest.itemUnderReview, 'reviewRequest.itemUnderReview'),
      reviewScope:     clean(clone.reviewRequest.reviewScope,     'reviewRequest.reviewScope'),
    };
  }

  if (clone.blocker) {
    clone.blocker = {
      ...clone.blocker,
      reason:        clean(clone.blocker.reason,        'blocker.reason'),
      suggestedRoute: clean(clone.blocker.suggestedRoute, 'blocker.suggestedRoute'),
    };
  }

  return { result: clone, injectionFields };
}

/**
 * Parse a structured completion payload from the agent's full text response.
 *
 * Scans for a JSON fence containing `"__bormagi_outcome__": true`.
 * Returns null when no valid payload is found — callers should treat that as a
 * plain `completed` outcome.
 *
 * Never throws — malformed JSON is silently treated as plain completion.
 */
export function parseStructuredCompletion(responseText: string): ParsedResult | null {
  const fencePattern = /```(?:json)?\s*(\{[\s\S]*?"__bormagi_outcome__"\s*:\s*true[\s\S]*?\})\s*```/;
  const match = responseText.match(fencePattern);
  if (!match) { return null; }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const outcome = raw['outcome'] as string;
  if (!Object.values(ExecutionOutcome).includes(outcome as ExecutionOutcome)) {
    return null;
  }

  const result: ParsedResult = {
    outcome: outcome as AgentExecutionResult['outcome'],
    summary: (raw['summary'] as string | undefined) ?? '',
    producedArtifactIds: (raw['producedArtifactIds'] as string[] | undefined) ?? [],
    delegateTo: (raw['toAgentId'] as string | undefined) ?? null,
    handoffRequest: null,
    reviewRequest:  null,
    blocker:        null,
  };

  if (outcome === ExecutionOutcome.Delegated && raw['toAgentId']) {
    result.handoffRequest = {
      workflowId:          '',
      taskId:              '',
      parentTaskId:        null,
      stageId:             '',
      fromAgentId:         '',
      toAgentId:           raw['toAgentId'] as string,
      returnToAgentId:     null,
      objective:           (raw['objective']        as string | undefined) ?? result.summary,
      reasonForHandoff:    (raw['reasonForHandoff'] as string | undefined) ?? '',
      inputArtifactIds:    (raw['inputArtifactIds'] as string[] | undefined) ?? [],
      relevantDecisionIds: (raw['relevantDecisionIds'] as string[] | undefined) ?? [],
      constraints:         (raw['constraints']      as string[] | undefined) ?? [],
      expectedOutputs:     (raw['expectedOutputs']  as string[] | undefined) ?? [],
      doneCriteria:        (raw['doneCriteria']      as string[] | undefined) ?? [],
      isBlocking:          (raw['isBlocking']        as boolean | undefined) ?? true,
    };
  }

  if (outcome === ExecutionOutcome.ReviewRequested && raw['reviewerAgentId']) {
    result.reviewRequest = {
      workflowId:         '',
      taskId:             '',
      requestingAgentId:  '',
      reviewerAgentId:    raw['reviewerAgentId'] as string,
      itemUnderReview:    (raw['itemUnderReview']  as string   | undefined) ?? result.summary,
      reviewScope:        (raw['reviewScope']      as string   | undefined) ?? '',
      reviewCriteria:     (raw['reviewCriteria']   as string[] | undefined) ?? [],
      isBlocking:         (raw['isBlocking']       as boolean  | undefined) ?? true,
    };
  }

  if (outcome === ExecutionOutcome.Blocked && raw['reason']) {
    result.blocker = {
      workflowId:       '',
      stageId:          '',
      taskId:           '',
      raisedByAgentId:  '',
      reason:          raw['reason'] as string,
      severity:        (raw['severity'] as NonNullable<AgentExecutionResult['blocker']>['severity']) ?? 'medium',
      suggestedRoute:  (raw['suggestedRoute'] as string | undefined) ?? '',
    };
  }

  return result;
}
