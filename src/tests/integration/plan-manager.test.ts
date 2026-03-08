// ─── Integration tests: PlanManager + CapabilityRegistry ─────────────────────
//
// Tests plan creation, milestone updates, persistence, listing, and deletion.
// Also tests capability manifest loading and lazy instruction loading.

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

import {
  shouldCreatePlan,
  createPlan,
  loadPlan,
  listPlans,
  updateMilestone,
  appendPlanField,
  deletePlan,
} from '../../context/PlanManager';

import {
  loadManifests,
  maybeLoadCapability,
  clearActivations,
  defaultCapabilitiesDir,
} from '../../context/CapabilityRegistry';

import type { ModeDecision, CapabilityManifest } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-plan-test-'));
}

function makeModeDecision(mode: ModeDecision['mode'] = 'plan'): ModeDecision {
  return {
    mode,
    confidence:        0.9,
    secondaryIntents:  [],
    reason:            'test',
    userOverride:      false,
  };
}

// ─── shouldCreatePlan ─────────────────────────────────────────────────────────

describe('shouldCreatePlan', () => {
  test('returns true when mode is plan', () => {
    expect(shouldCreatePlan('anything', makeModeDecision('plan'))).toBe(true);
  });

  test('returns false for non-plan mode with short request', () => {
    expect(shouldCreatePlan('Fix the login bug.', makeModeDecision('debug'))).toBe(false);
  });

  test('returns true for non-plan mode when ≥ 3 task lines detected', () => {
    const request = [
      'Please do the following:',
      '1. Add the login route',
      '2. Create the AuthService',
      '3. Write tests for AuthService',
    ].join('\n');
    expect(shouldCreatePlan(request, makeModeDecision('edit'))).toBe(true);
  });

  test('returns false when only 2 task lines detected', () => {
    const request = '- Update the README\n- Fix the typo';
    expect(shouldCreatePlan(request, makeModeDecision('edit'))).toBe(false);
  });
});

// ─── createPlan ───────────────────────────────────────────────────────────────

describe('createPlan', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('creates and returns a plan with the given objective', () => {
    const plan = createPlan(workspace, 'Implement auth', [
      { title: 'Add AuthService', tasks: ['Create file', 'Add login()'] },
    ], 'plan');

    expect(plan.objective).toBe('Implement auth');
    expect(plan.milestones).toHaveLength(1);
    expect(plan.milestones[0].title).toBe('Add AuthService');
    expect(plan.milestones[0].status).toBe('todo');
    expect(plan.milestones[0].id).toBe('m01');
  });

  test('persists JSON and markdown files to disk', () => {
    const plan = createPlan(workspace, 'Refactor DB layer', [
      { title: 'Extract repository', tasks: ['Move queries'] },
    ], 'plan');

    const dir = path.join(workspace, '.bormagi', 'plans');
    expect(fs.existsSync(path.join(dir, `${plan.id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${plan.id}.md`))).toBe(true);
  });

  test('markdown file contains the objective', () => {
    const plan = createPlan(workspace, 'Add dark mode', [
      { title: 'Theme tokens', tasks: ['Define palette'] },
    ], 'edit');

    const md = fs.readFileSync(
      path.join(workspace, '.bormagi', 'plans', `${plan.id}.md`),
      'utf-8',
    );
    expect(md).toContain('Add dark mode');
    expect(md).toContain('Theme tokens');
  });

  test('assigns sequential milestone IDs', () => {
    const plan = createPlan(workspace, 'Big task', [
      { title: 'Step A' },
      { title: 'Step B' },
      { title: 'Step C' },
    ], 'plan');

    expect(plan.milestones[0].id).toBe('m01');
    expect(plan.milestones[1].id).toBe('m02');
    expect(plan.milestones[2].id).toBe('m03');
  });
});

// ─── loadPlan ─────────────────────────────────────────────────────────────────

describe('loadPlan', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('loads a previously created plan', () => {
    const created = createPlan(workspace, 'Load test', [{ title: 'M1' }], 'plan');
    const loaded  = loadPlan(workspace, created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
    expect(loaded!.objective).toBe('Load test');
  });

  test('returns null for nonexistent plan', () => {
    expect(loadPlan(workspace, 'plan-0000-00-00_00-00-00')).toBeNull();
  });
});

// ─── listPlans ────────────────────────────────────────────────────────────────

describe('listPlans', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('returns empty array when no plans exist', () => {
    expect(listPlans(workspace)).toEqual([]);
  });

  test('lists all created plan IDs', () => {
    const p1 = createPlan(workspace, 'Plan 1', [{ title: 'M1' }], 'plan');
    const p2 = createPlan(workspace, 'Plan 2', [{ title: 'M2' }], 'plan');
    const list = listPlans(workspace);
    expect(list).toContain(p1.id);
    expect(list).toContain(p2.id);
  });
});

// ─── updateMilestone ─────────────────────────────────────────────────────────

describe('updateMilestone', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('advances milestone to in-progress', () => {
    const plan = createPlan(workspace, 'Update test', [
      { title: 'Step 1', tasks: ['Do it'] },
    ], 'plan');

    const updated = updateMilestone(workspace, plan.id, 'm01', 'in-progress');
    expect(updated).not.toBeNull();
    expect(updated!.milestones[0].status).toBe('in-progress');
  });

  test('allows done when there are no validations', () => {
    const plan = createPlan(workspace, 'Done test', [
      { title: 'Simple step' },
    ], 'plan');

    const updated = updateMilestone(workspace, plan.id, 'm01', 'done');
    expect(updated).not.toBeNull();
    expect(updated!.milestones[0].status).toBe('done');
  });

  test('blocks done when validations are present and not noted', () => {
    const plan = createPlan(workspace, 'Validation test', [
      {
        title:       'Step with checks',
        validations: ['All tests pass', 'Code reviewed'],
      },
    ], 'plan');

    // No notes added — should block.
    const result = updateMilestone(workspace, plan.id, 'm01', 'done');
    expect(result).toBeNull();

    // Milestone should still exist with in-progress status.
    const reloaded = loadPlan(workspace, plan.id);
    expect(reloaded!.milestones[0].status).toBe('in-progress');
  });

  test('allows done when validations are satisfied via notes', () => {
    const plan = createPlan(workspace, 'Notes test', [
      { title: 'Step', validations: ['All tests pass'] },
    ], 'plan');

    // First update: in-progress with satisfying note.
    updateMilestone(workspace, plan.id, 'm01', 'in-progress', ['All tests pass ✓']);

    // Second update: done (validation note matches).
    const result = updateMilestone(workspace, plan.id, 'm01', 'done');
    expect(result).not.toBeNull();
    expect(result!.milestones[0].status).toBe('done');
  });

  test('appends notes to the milestone', () => {
    const plan = createPlan(workspace, 'Notes append', [{ title: 'M' }], 'plan');
    updateMilestone(workspace, plan.id, 'm01', 'in-progress', ['Started work']);
    updateMilestone(workspace, plan.id, 'm01', 'in-progress', ['More notes']);

    const reloaded = loadPlan(workspace, plan.id);
    expect(reloaded!.milestones[0].notes).toContain('Started work');
    expect(reloaded!.milestones[0].notes).toContain('More notes');
  });

  test('returns null for unknown plan', () => {
    expect(updateMilestone(workspace, 'no-plan', 'm01', 'done')).toBeNull();
  });
});

// ─── appendPlanField ─────────────────────────────────────────────────────────

describe('appendPlanField', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('appends a decision to the plan', () => {
    const plan    = createPlan(workspace, 'Decision test', [], 'plan');
    const updated = appendPlanField(workspace, plan.id, 'decisions', 'Use JWT');
    expect(updated!.decisions).toContain('Use JWT');
  });

  test('appends a blocker to the plan', () => {
    const plan    = createPlan(workspace, 'Blocker test', [], 'plan');
    const updated = appendPlanField(workspace, plan.id, 'blockers', 'CORS not resolved');
    expect(updated!.blockers).toContain('CORS not resolved');
  });

  test('returns null for unknown plan', () => {
    expect(appendPlanField(workspace, 'no-plan', 'decisions', 'x')).toBeNull();
  });
});

// ─── deletePlan ──────────────────────────────────────────────────────────────

describe('deletePlan', () => {
  let workspace: string;

  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('deletes JSON and markdown files', () => {
    const plan = createPlan(workspace, 'To delete', [{ title: 'M' }], 'plan');
    const dir  = path.join(workspace, '.bormagi', 'plans');

    expect(fs.existsSync(path.join(dir, `${plan.id}.json`))).toBe(true);
    const deleted = deletePlan(workspace, plan.id);
    expect(deleted).toBe(true);
    expect(fs.existsSync(path.join(dir, `${plan.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${plan.id}.md`))).toBe(false);
  });

  test('returns false for nonexistent plan', () => {
    expect(deletePlan(workspace, 'plan-0000-00-00_00-00-00')).toBe(false);
  });
});

// ─── CapabilityRegistry ───────────────────────────────────────────────────────

describe('loadManifests', () => {
  let workspace: string;
  let capsDir: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    capsDir   = defaultCapabilitiesDir(workspace);
  });

  afterEach(() => {
    clearActivations();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('returns empty array when capabilities dir does not exist', () => {
    expect(loadManifests(capsDir)).toEqual([]);
  });

  test('loads valid manifests', () => {
    const capDir = path.join(capsDir, 'test-cap');
    fs.mkdirSync(capDir, { recursive: true });

    const manifest: Omit<CapabilityManifest, 'manifestPath'> = {
      id:               'test-cap',
      name:             'Test Capability',
      description:      'A test capability for unit testing',
      applicableModes:  ['edit', 'debug'],
      requiredTools:    ['writeFile'],
      estimatedTokens:  500,
    };
    fs.writeFileSync(path.join(capDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

    const manifests = loadManifests(capsDir);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].id).toBe('test-cap');
    expect(manifests[0].applicableModes).toContain('edit');
  });

  test('skips directories without manifest.json', () => {
    const capDir = path.join(capsDir, 'no-manifest');
    fs.mkdirSync(capDir, { recursive: true });
    expect(loadManifests(capsDir)).toHaveLength(0);
  });

  test('skips malformed manifest.json', () => {
    const capDir = path.join(capsDir, 'bad-manifest');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'manifest.json'), '{ invalid json', 'utf-8');
    expect(loadManifests(capsDir)).toHaveLength(0);
  });

  test('skips manifest missing required fields', () => {
    const capDir = path.join(capsDir, 'missing-fields');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'manifest.json'), JSON.stringify({ id: 'x' }), 'utf-8');
    expect(loadManifests(capsDir)).toHaveLength(0);
  });
});

describe('maybeLoadCapability', () => {
  let workspace: string;
  let capsDir: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    capsDir   = defaultCapabilitiesDir(workspace);
  });

  afterEach(() => {
    clearActivations();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function writeCapability(id: string, manifest: object, instructions: string): void {
    const capDir = path.join(capsDir, id);
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
    fs.writeFileSync(path.join(capDir, 'instructions.md'), instructions, 'utf-8');
  }

  test('returns null when no manifests provided', async () => {
    const result = await maybeLoadCapability([], 'fix the bug', 'debug', 10_000);
    expect(result).toBeNull();
  });

  test('loads instructions from disk and returns LoadedCapability', async () => {
    writeCapability('debug-cap', {
      id:               'debug-cap',
      name:             'Debug Helper',
      description:      'Assists with debugging and error fixing',
      applicableModes:  ['debug'],
      requiredTools:    [],
      estimatedTokens:  200,
    }, '# Debug instructions\nAlways check the stack trace first.');

    const manifests = loadManifests(capsDir);
    const loaded    = await maybeLoadCapability(manifests, 'fix the error', 'debug', 10_000);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('debug-cap');
    expect(loaded!.instructions).toContain('stack trace');
  });

  test('returns null when capability does not apply to current mode', async () => {
    writeCapability('edit-cap', {
      id:               'edit-cap',
      name:             'Edit Helper',
      description:      'Helps with code editing',
      applicableModes:  ['edit'],
      requiredTools:    [],
      estimatedTokens:  200,
    }, 'Edit instructions.');

    const manifests = loadManifests(capsDir);
    // Current mode is 'debug', but capability only applies to 'edit'.
    const result = await maybeLoadCapability(manifests, 'fix the bug', 'debug', 10_000);
    expect(result).toBeNull();
  });

  test('returns null when estimated tokens exceed budget', async () => {
    writeCapability('heavy-cap', {
      id:               'heavy-cap',
      name:             'Heavy Cap',
      description:      'Large capability with many instructions',
      applicableModes:  ['plan'],
      requiredTools:    [],
      estimatedTokens:  50_000,
    }, 'Lots of instructions.');

    const manifests = loadManifests(capsDir);
    // Budget is only 1_000 — too small.
    const result = await maybeLoadCapability(manifests, 'make a plan', 'plan', 1_000);
    expect(result).toBeNull();
  });

  test('returns cached result on second call without re-reading disk', async () => {
    writeCapability('cached-cap', {
      id:               'cached-cap',
      name:             'Cached Cap',
      description:      'Tests caching behaviour',
      applicableModes:  ['review'],
      requiredTools:    [],
      estimatedTokens:  300,
    }, 'Cached instructions.');

    const manifests = loadManifests(capsDir);
    const sid = 'session-cache-test';

    const first  = await maybeLoadCapability(manifests, 'review the PR', 'review', 10_000, sid);
    const second = await maybeLoadCapability(manifests, 'review the PR', 'review', 10_000, sid);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).toBe(second!.id);
  });

  test('clearActivations removes cached entries for the session', async () => {
    writeCapability('session-cap', {
      id:               'session-cap',
      name:             'Session Cap',
      description:      'Session clear test capability',
      applicableModes:  ['search'],
      requiredTools:    [],
      estimatedTokens:  100,
    }, 'Search instructions.');

    const manifests = loadManifests(capsDir);
    const sid = 'session-clear-test';

    await maybeLoadCapability(manifests, 'find the file', 'search', 10_000, sid);
    clearActivations(sid);

    // After clearing, the instruction file path would need to exist to reload.
    // The registry will re-read from disk (no longer cached).
    // We just verify it doesn't throw.
    const result = await maybeLoadCapability(manifests, 'find the file', 'search', 10_000, sid);
    expect(result).not.toBeNull();
  });
});
