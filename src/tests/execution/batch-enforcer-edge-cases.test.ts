/**
 * Edge-case tests for BatchEnforcer.detectWorkspaceType() (DD3).
 * Verifies correct classification for doc-only repos, backend dirs,
 * and boundary source file counts.
 *
 * checkWritePermission tests updated to use templateRequiresBatch (boolean)
 * instead of workspace type — enforcement is now template-driven.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BatchEnforcer } from '../../agents/execution/BatchEnforcer';

describe('BatchEnforcer.detectWorkspaceType — edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bormagi-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('empty directory → greenfield', async () => {
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('greenfield');
  });

  test('docs-only repo (only .md files) → docs_only', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Project');
    await fs.mkdir(path.join(tmpDir, 'docs'));
    await fs.writeFile(path.join(tmpDir, 'docs', 'plan.md'), '## Plan');
    await fs.writeFile(path.join(tmpDir, 'docs', 'spec.md'), '## Spec');
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('docs_only');
  });

  test('.bormagi/ plans only → greenfield', async () => {
    await fs.mkdir(path.join(tmpDir, '.bormagi', 'plans'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.bormagi', 'plans', 'plan.md'), 'plan');
    const enforcer = new BatchEnforcer(tmpDir);
    // .bormagi starts with dot → hidden, should not count toward maturity
    expect(await enforcer.detectWorkspaceType()).toBe('greenfield');
  });

  test('package.json only (no source files) → scaffolded', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('package.json + 4 source files → scaffolded', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(srcDir, `file${i}.ts`), `// file ${i}`);
    }
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('package.json + exactly 5 source files → mature', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(srcDir, `file${i}.ts`), `// file ${i}`);
    }
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('mature');
  });

  test('backend/ dir without package.json → scaffolded', async () => {
    await fs.mkdir(path.join(tmpDir, 'backend'));
    await fs.writeFile(path.join(tmpDir, 'backend', 'main.py'), 'print("hello")');
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('frontend/ dir without package.json → scaffolded', async () => {
    await fs.mkdir(path.join(tmpDir, 'frontend'));
    await fs.writeFile(path.join(tmpDir, 'frontend', 'App.tsx'), 'export default App');
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('app/ dir without package.json → scaffolded', async () => {
    await fs.mkdir(path.join(tmpDir, 'app'));
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('package.json + many source files across subdirectories → mature', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const srcDir = path.join(tmpDir, 'src');
    const compDir = path.join(srcDir, 'components');
    await fs.mkdir(compDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(srcDir, `file${i}.ts`), '');
    }
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(compDir, `Comp${i}.tsx`), '');
    }
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('mature');
  });

  test('node_modules files not counted toward source count', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const nmDir = path.join(tmpDir, 'node_modules', 'some-pkg');
    await fs.mkdir(nmDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(nmDir, `file${i}.js`), '');
    }
    const enforcer = new BatchEnforcer(tmpDir);
    // 0 source files counted (node_modules excluded) → scaffolded
    expect(await enforcer.detectWorkspaceType()).toBe('scaffolded');
  });

  test('mixed file types (.py, .go, .rs) count as source', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
    await fs.writeFile(path.join(srcDir, 'main.py'), '');
    await fs.writeFile(path.join(srcDir, 'main.go'), '');
    await fs.writeFile(path.join(srcDir, 'main.rs'), '');
    await fs.writeFile(path.join(srcDir, 'main.java'), '');
    await fs.writeFile(path.join(srcDir, 'main.ts'), '');
    const enforcer = new BatchEnforcer(tmpDir);
    expect(await enforcer.detectWorkspaceType()).toBe('mature');
  });
});

describe('BatchEnforcer.checkWritePermission — edge cases', () => {
  const enforcer = new BatchEnforcer('/ws');

  function makeState(batch: string[] = [], completed: string[] = []) {
    return {
      version: 2, agentId: 'test', objective: '', mode: 'code',
      workspaceRoot: '/ws', resolvedInputs: [], artifactsCreated: completed,
      completedSteps: [], nextActions: [], blockers: [], techStack: {},
      iterationsUsed: 0, plannedFileBatch: batch,
      completedBatchFiles: completed, updatedAt: '', executedTools: [],
    } as any;
  }

  test('backslash paths normalised for batch matching', () => {
    const state = makeState(['src/index.ts']);
    expect(enforcer.checkWritePermission('src\\index.ts', state, 'BLOCKED', true)).toBeNull();
  });

  test('leading slash stripped for batch matching', () => {
    const state = makeState(['src/index.ts']);
    expect(enforcer.checkWritePermission('/src/index.ts', state, 'BLOCKED', true)).toBeNull();
  });

  test('template with requiresBatch=false → always allowed regardless of batch state', () => {
    const state = makeState([]);
    expect(enforcer.checkWritePermission('src/x.ts', state, 'BLOCKED', false)).toBeNull();
  });
});
