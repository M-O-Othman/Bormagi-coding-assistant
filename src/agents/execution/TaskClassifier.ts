import type { AssistantMode } from '../../context/types';
import type { TaskTemplateName } from './TaskTemplate';

/**
 * Rule-based task shape classifier (PQ-7 Option A: no LLM call).
 *
 * Classifies the task once at run start from the user message and mode.
 * Drives stop rules, batch requirements, skill loading, and milestone decisions.
 */
export function classifyTask(userMessage: string, mode: AssistantMode): TaskTemplateName {
  // plan mode always → plan_only
  if (mode === 'plan') { return 'plan_only'; }

  // ask mode always → investigate_then_report (read-only, produce a report)
  if (mode === 'ask') { return 'investigate_then_report'; }

  const text = userMessage.toLowerCase();

  // explicit plan_only signals
  if (/\b(plan\s+only|do\s+not\s+implement|design\s+only|no\s+code)\b/i.test(text)) {
    return 'plan_only';
  }

  // document_then_wait: "write X and wait / stop / pause / review"
  if (
    /\b(write|create|produce)\b.{0,60}(question|doc|document|summary|proposal|spec)\b.*\b(wait|stop|pause|review|then\s+wait)\b/i.test(text) ||
    /\b(draft|document)\b.{0,30}(then\s+wait|and\s+wait|for\s+review)\b/i.test(text)
  ) {
    return 'document_then_wait';
  }

  // greenfield signals
  if (/\b(scaffold|bootstrap|start\s+from\s+scratch)\b/i.test(text) ||
      /\bcreate\s+(a\s+)?(new\s+)?\w*\s*(project|application|service|repo|repository)\b/i.test(text) ||
      /\bnew\s+\w+\s*(project|app|application|service|repo|repository)\b/i.test(text)) {
    return 'greenfield_scaffold';
  }

  // multi-file refactor
  if (/\b(refactor|rename|move|reorganis[e|z]e)\b.{0,60}(across|all|multiple|every)\b/i.test(text)) {
    return 'multi_file_refactor';
  }

  // investigate_then_report: analysis with no write intent
  if (
    /\b(analys[ei]|analyze|investigate|review|audit|what.{0,20}wrong|find\s+out|diagnose|explain|describe)\b/i.test(text) &&
    !/\b(fix|write|create|implement|add|build|generate)\b/i.test(text)
  ) {
    return 'investigate_then_report';
  }

  // default: targeted patch to an existing project
  return 'existing_project_patch';
}
