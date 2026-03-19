import type { AssistantMode } from '../../context/types';

/**
 * Template names that describe the shape of the current task.
 * Classified once at run start by TaskClassifier; influences stop rules,
 * batch requirements, skill loading, and MilestoneFinalizer decisions.
 */
export type TaskTemplateName =
  | 'document_then_wait'
  | 'single_file_creation'
  | 'greenfield_scaffold'
  | 'existing_project_patch'
  | 'multi_file_refactor'
  | 'investigate_then_report'
  | 'plan_only';

export interface TaskTemplate {
  name: TaskTemplateName;
  /** Must declare file batch before writing. */
  requiresBatch: boolean;
  /** May use discovery tools (read/list/glob). */
  allowDiscovery: boolean;
  /** Override default whole-file read budget. */
  maxWholeFileReads?: number;
  /** Wait after first write milestone (e.g. document_then_wait, investigate_then_report). */
  stopAfterWrite?: boolean;
  /** Human-readable stop rules shown in startup log. */
  stopRules: string[];
}

export const TASK_TEMPLATES: Record<TaskTemplateName, TaskTemplate> = {
  document_then_wait: {
    name: 'document_then_wait',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Stop after writing deliverable document and wait for user response'],
  },
  single_file_creation: {
    name: 'single_file_creation',
    requiresBatch: false,
    allowDiscovery: false,
    maxWholeFileReads: 0,
    stopAfterWrite: true,
    stopRules: ['Write exactly the requested file', 'No extra files unless explicitly asked', 'No discovery — generate directly', 'Complete immediately after successful write'],
  },
  greenfield_scaffold: {
    name: 'greenfield_scaffold',
    requiresBatch: true,
    allowDiscovery: true,
    stopRules: ['Declare batch before first write', 'Lock architecture before scaffold'],
  },
  existing_project_patch: {
    name: 'existing_project_patch',
    requiresBatch: false,
    allowDiscovery: true,
    stopRules: ['Fix targeted files only', 'Validate after each write'],
  },
  multi_file_refactor: {
    name: 'multi_file_refactor',
    requiresBatch: true,
    allowDiscovery: true,
    stopRules: ['Declare all affected files in batch', 'Validate after batch completion'],
  },
  investigate_then_report: {
    name: 'investigate_then_report',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Investigate codebase', 'Write report file', 'Stop and wait'],
  },
  plan_only: {
    name: 'plan_only',
    requiresBatch: false,
    allowDiscovery: true,
    stopAfterWrite: true,
    stopRules: ['Write plan document only', 'Do not implement code'],
  },
};

/**
 * Map from task template name to recommended skill fragments.
 * Skills are loaded from src/skills/<name>.md at runtime.
 */
export const TEMPLATE_SKILL_MAP: Partial<Record<TaskTemplateName, string[]>> = {
  single_file_creation: ['implement-feature'],
  greenfield_scaffold: ['implement-feature'],
  existing_project_patch: ['codebase-navigator', 'implement-feature'],
  multi_file_refactor: ['codebase-navigator'],
  investigate_then_report: ['bug-investigator', 'codebase-navigator'],
  document_then_wait: ['codebase-navigator'],
};

// Re-export AssistantMode so callers don't need a separate import
export type { AssistantMode };
