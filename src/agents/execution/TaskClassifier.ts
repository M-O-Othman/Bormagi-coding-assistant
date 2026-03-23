import type { AssistantMode } from '../../context/types';
import type { TaskTemplateName } from './TaskTemplate';
import type { WorkspaceType } from './BatchEnforcer';

// ─── Requirements-driven build detection (bug-fix-008 Fix 1) ─────────────────

/**
 * Returns true when the user message signals a requirements-driven greenfield
 * implementation in a docs-only workspace with a preloaded spec.
 *
 * This rule must fire BEFORE generic greenfield / patch fallbacks so that
 * "start implementing the system defined in requirements.md" in a docs-only
 * workspace is never misclassified as `existing_project_patch`.
 */
function isRequirementsDrivenBuild(
  userText: string,
  workspaceType: WorkspaceType | undefined,
  resolvedInputs: string[],
): boolean {
  const text = userText.toLowerCase();

  // Must have explicit implementation intent
  const hasImplementationIntent =
    text.includes('implement') ||
    text.includes('start implementing') ||
    text.includes('build the system') ||
    text.includes('build from') ||
    text.includes('write the system');

  if (!hasImplementationIntent) { return false; }

  // Must reference a spec/requirements doc
  const referencesSpec =
    text.includes('requirements.md') ||
    text.includes('spec') ||
    text.includes('design document') ||
    text.includes('defined in requirements') ||
    text.includes('based on requirements') ||
    text.includes('from requirements');

  if (!referencesSpec) { return false; }

  // Must be in a docs-only (or greenfield) workspace
  const isDocsOnlyWorkspace =
    workspaceType === 'docs_only' || workspaceType === 'greenfield';

  if (!isDocsOnlyWorkspace) { return false; }

  // Must have already resolved a requirements/spec file
  const hasResolvedSpec = resolvedInputs.some(
    p => /requirements\.md$/i.test(p) || /spec\.md$/i.test(p),
  );

  return hasResolvedSpec;
}

/**
 * Rule-based task shape classifier (PQ-7 Option A: no LLM call).
 *
 * Classifies the task once at run start from the user message, mode, and workspace type.
 * Drives stop rules, batch requirements, skill loading, and milestone decisions.
 */
/**
 * Rule-based task shape classifier (PQ-7 Option A: no LLM call).
 *
 * Classifies the task once at run start from the user message, mode,
 * workspace type, and already-resolved input file paths.
 * Drives stop rules, batch requirements, skill loading, and milestone decisions.
 *
 * @param userMessage    Raw user message.
 * @param mode           Active assistant mode.
 * @param workspaceType  Detected workspace type (optional).
 * @param resolvedInputs Paths of files already read/preloaded this session.
 *                       Used for requirements_driven_build detection.
 */
export function classifyTask(
  userMessage: string,
  mode: AssistantMode,
  workspaceType?: WorkspaceType,
  resolvedInputs: string[] = [],
): TaskTemplateName {
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

  // requirements_driven_build — must be checked BEFORE generic greenfield/patch rules
  // so that implementation requests in docs-only workspaces are never misclassified
  if (isRequirementsDrivenBuild(text, workspaceType, resolvedInputs)) {
    return 'requirements_driven_build';
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

  // Creation intent in empty/docs-only workspace
  if (workspaceType && (workspaceType === 'greenfield' || workspaceType === 'docs_only')) {
    const hasCreationVerb = /\b(make|create|build|write|generate)\b/i.test(text);

    // Count explicit filenames in the request
    const explicitFiles = text.match(/[\w.-]+\.(?:html|js|ts|tsx|jsx|css|py|java|go|rs|json|md|txt|yaml|yml|toml|xml|sh|bat|rb|php|c|cpp|h)\b/gi);
    const fileCount = explicitFiles ? new Set(explicitFiles.map(f => f.toLowerCase())).size : 0;

    // Single explicit filename → single_file_creation (no batch, no discovery, write directly)
    if (hasCreationVerb && fileCount === 1) {
      return 'single_file_creation';
    }

    // General creation intent (app/game/tool) with no multi-file signals → single_file_creation
    if (hasCreationVerb && fileCount === 0 &&
        /\b(app|page|file|site|website|tool|game|clock|calculator|timer|component|widget|form|dashboard)\b/i.test(text) &&
        !/\b(multiple|several|separate)\s+(files?|components?|pages?)\b/i.test(text)) {
      return 'single_file_creation';
    }

    // Multi-file creation or explicit multi-file signals → greenfield_scaffold
    if (hasCreationVerb) {
      return 'greenfield_scaffold';
    }
  }

  // default: targeted patch to an existing project
  return 'existing_project_patch';
}
