// ─── Plan Manager ─────────────────────────────────────────────────────────────
//
// Creates, persists, and updates structured execution plans for multi-file or
// multi-step coding tasks.  Plans are stored in two formats:
//
//   .bormagi/plans/<id>.json  — machine-readable (full ExecutionPlan)
//   .bormagi/plans/<id>.md   — human-readable markdown summary
//
// Plans are triggered when a request is classified as `plan` mode or when the
// assistant detects that more than one milestone is needed to satisfy the goal
// (heuristic: ≥ 3 distinct files to change, or explicitly requested by user).
//
// A plan milestone must pass validation before it can be marked `done`.
// Validation failures keep the milestone in `in-progress` state.
//
// Design decisions (from spec answers):
//   OQ-12: Plans stored in .bormagi/plans/
//   OQ-13: Plan creation triggered on `plan` mode or multi-file detection
//
// Spec reference: §FR-15B + Phase 5, §5.3.

import * as fs   from 'fs';
import * as path from 'path';
import type {
  ExecutionPlan,
  PlanMilestone,
  AssistantMode,
  ModeDecision,
} from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PLANS_DIR_RELATIVE = path.join('.bormagi', 'plans');

/**
 * Minimum number of tasks in the request that warrants creating a plan
 * when the mode is not explicitly `plan`.
 */
const MIN_TASKS_FOR_AUTO_PLAN = 3;

// ─── ID generation ────────────────────────────────────────────────────────────

function generatePlanId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `plan-${ts}`;
}

function generateMilestoneId(index: number): string {
  return `m${String(index + 1).padStart(2, '0')}`;
}

// ─── Markdown serialisation ───────────────────────────────────────────────────

function planToMarkdown(plan: ExecutionPlan): string {
  const lines: string[] = [
    `# Execution Plan — ${plan.id}`,
    ``,
    `**Objective:** ${plan.objective}`,
    `**Created:** ${plan.createdAtUtc}`,
    `**Updated:** ${plan.updatedAtUtc}`,
    ``,
  ];

  if (plan.decisions.length > 0) {
    lines.push(`## Decisions`);
    plan.decisions.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }

  if (plan.blockers.length > 0) {
    lines.push(`## Blockers`);
    plan.blockers.forEach(b => lines.push(`- ${b}`));
    lines.push('');
  }

  lines.push(`## Milestones`);
  plan.milestones.forEach((m, i) => {
    const statusBadge = {
      'todo':        '⬜',
      'in-progress': '🔵',
      'blocked':     '🔴',
      'done':        '✅',
    }[m.status] ?? '❓';

    lines.push(``, `### ${i + 1}. ${statusBadge} ${m.title} \`[${m.status}]\``);

    if (m.tasks.length > 0) {
      lines.push(`**Tasks:**`);
      m.tasks.forEach(t => lines.push(`- ${t}`));
    }

    if (m.validations.length > 0) {
      lines.push(`**Validations:**`);
      m.validations.forEach(v => lines.push(`- [ ] ${v}`));
    }

    if (m.notes && m.notes.length > 0) {
      lines.push(`**Notes:**`);
      m.notes.forEach(n => lines.push(`> ${n}`));
    }
  });

  return lines.join('\n');
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

function plansDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, PLANS_DIR_RELATIVE);
}

function jsonPath(workspaceRoot: string, planId: string): string {
  return path.join(plansDir(workspaceRoot), `${planId}.json`);
}

function mdPath(workspaceRoot: string, planId: string): string {
  return path.join(plansDir(workspaceRoot), `${planId}.md`);
}

function writePlan(workspaceRoot: string, plan: ExecutionPlan): void {
  const dir = plansDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath(workspaceRoot, plan.id), JSON.stringify(plan, null, 2), 'utf-8');
  fs.writeFileSync(mdPath(workspaceRoot, plan.id),   planToMarkdown(plan),           'utf-8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine whether the assistant should create an execution plan for this
 * request.
 *
 * Creates a plan when:
 *   - Mode is explicitly `plan`, OR
 *   - The number of task lines detected in the request body exceeds the
 *     auto-plan threshold (simple heuristic: lines starting with a dash,
 *     number, or step keyword).
 *
 * @param requestText   Raw user request text.
 * @param modeDecision  Classified mode for the request.
 */
export function shouldCreatePlan(requestText: string, modeDecision: ModeDecision): boolean {
  if (modeDecision.mode === 'plan') { return true; }

  // Heuristic: count lines that look like explicit task items.
  const taskLines = requestText
    .split('\n')
    .filter(line => /^\s*(\d+[.)]\s|-\s|step\s|\*\s)/i.test(line));

  return taskLines.length >= MIN_TASKS_FOR_AUTO_PLAN;
}

/**
 * Create a new execution plan and persist it to disk.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param objective      One-sentence description of the overall goal.
 * @param milestoneSpecs Array of milestone definitions. Each spec provides a
 *                       title and an optional list of task strings and
 *                       validation steps.
 * @param mode           Active assistant mode (recorded for telemetry).
 * @returns              The newly created `ExecutionPlan`.
 */
export function createPlan(
  workspaceRoot: string,
  objective: string,
  milestoneSpecs: Array<{
    title: string;
    tasks?: string[];
    validations?: string[];
  }>,
  _mode: AssistantMode,
): ExecutionPlan {
  const now = new Date().toISOString();
  const id  = generatePlanId();

  const milestones: PlanMilestone[] = milestoneSpecs.map((spec, i) => ({
    id:          generateMilestoneId(i),
    title:       spec.title,
    tasks:       spec.tasks       ?? [],
    validations: spec.validations ?? [],
    status:      'todo',
    notes:       [],
  }));

  const plan: ExecutionPlan = {
    id,
    objective,
    milestones,
    decisions: [],
    blockers:  [],
    createdAtUtc: now,
    updatedAtUtc: now,
  };

  writePlan(workspaceRoot, plan);
  return plan;
}

/**
 * Load an existing plan from disk.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param planId         The plan identifier (e.g. `plan-2025-01-15_10-30-00`).
 * @returns              The `ExecutionPlan` or `null` when not found.
 */
export function loadPlan(workspaceRoot: string, planId: string): ExecutionPlan | null {
  const file = jsonPath(workspaceRoot, planId);
  if (!fs.existsSync(file)) { return null; }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as ExecutionPlan;
  } catch {
    return null;
  }
}

/**
 * List all plan IDs available in the workspace.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @returns              Sorted array of plan IDs (newest first).
 */
export function listPlans(workspaceRoot: string): string[] {
  const dir = plansDir(workspaceRoot);
  if (!fs.existsSync(dir)) { return []; }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/**
 * Update the status and optionally append notes to a milestone.
 *
 * If the new status is `done` but any validation steps have not been checked
 * off (marked with an `[x]`-style prefix in `notes`), the advancement is
 * blocked and the milestone stays `in-progress`.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param planId         The plan identifier.
 * @param milestoneId    The milestone identifier (e.g. `m01`).
 * @param status         New status to apply.
 * @param notes          Optional notes to append.
 * @returns              The updated plan, or `null` when not found.
 *                       Returns `null` also when validation blocks advancement.
 */
export function updateMilestone(
  workspaceRoot: string,
  planId: string,
  milestoneId: string,
  status: PlanMilestone['status'],
  notes?: string[],
): ExecutionPlan | null {
  const plan = loadPlan(workspaceRoot, planId);
  if (!plan) { return null; }

  const milestone = plan.milestones.find(m => m.id === milestoneId);
  if (!milestone) { return null; }

  // Validation gate: if marking done, require at least a validation note or no
  // pending validations.
  if (status === 'done' && milestone.validations.length > 0) {
    const existingNotes = milestone.notes ?? [];
    const allChecked = milestone.validations.every(v => {
      return existingNotes.some(n => n.toLowerCase().includes(v.toLowerCase().slice(0, 30)));
    });
    if (!allChecked) {
      // Block advancement — keep in-progress.
      milestone.status = 'in-progress';
      if (notes) {
        milestone.notes = [...(milestone.notes ?? []), ...notes];
      }
      plan.updatedAtUtc = new Date().toISOString();
      writePlan(workspaceRoot, plan);
      return null;
    }
  }

  milestone.status = status;
  if (notes && notes.length > 0) {
    milestone.notes = [...(milestone.notes ?? []), ...notes];
  }

  plan.updatedAtUtc = new Date().toISOString();
  writePlan(workspaceRoot, plan);
  return plan;
}

/**
 * Add a decision or blocker string to an existing plan.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param planId         The plan identifier.
 * @param field          `'decisions'` or `'blockers'`.
 * @param text           The text to append.
 * @returns              The updated plan, or `null` when not found.
 */
export function appendPlanField(
  workspaceRoot: string,
  planId: string,
  field: 'decisions' | 'blockers',
  text: string,
): ExecutionPlan | null {
  const plan = loadPlan(workspaceRoot, planId);
  if (!plan) { return null; }

  plan[field] = [...plan[field], text];
  plan.updatedAtUtc = new Date().toISOString();
  writePlan(workspaceRoot, plan);
  return plan;
}

/**
 * Delete a plan and its markdown file from disk.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param planId         The plan identifier.
 * @returns              `true` when deleted, `false` when not found.
 */
export function deletePlan(workspaceRoot: string, planId: string): boolean {
  const json = jsonPath(workspaceRoot, planId);
  const md   = mdPath(workspaceRoot, planId);
  if (!fs.existsSync(json)) { return false; }
  fs.rmSync(json, { force: true });
  if (fs.existsSync(md)) { fs.rmSync(md, { force: true }); }
  return true;
}
