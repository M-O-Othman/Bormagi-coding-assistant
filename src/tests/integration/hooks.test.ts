// ─── Integration tests: HookEngine ────────────────────────────────────────────
//
// Covers config loading, event matching, built-in handlers (protected-path-check
// and post-compaction-inject), shell hook execution, and result merging.

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

import { HookEngine } from '../../context/HookEngine';
import type { HookConfig } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-hooks-test-'));
}

function writeHooksConfig(workspaceRoot: string, configs: HookConfig[]): void {
  const dir = path.join(workspaceRoot, '.bormagi', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(configs), 'utf-8');
}

// ─── No config ────────────────────────────────────────────────────────────────

describe('HookEngine — no config', () => {
  let workspace: string;
  let engine: HookEngine;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    engine    = new HookEngine(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('allows everything when no hooks.json exists', async () => {
    const result = await engine.runHooks('before-tool', { mode: 'code', toolName: 'writeFile' });
    expect(result.allow).toBe(true);
  });

  test('configCount is 0 when no file exists', () => {
    expect(engine.configCount()).toBe(0);
  });
});

// ─── Config loading ───────────────────────────────────────────────────────────

describe('HookEngine — config loading', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('loads hook configs from .bormagi/config/hooks.json', () => {
    const configs: HookConfig[] = [
      { event: 'session-start', type: 'internal', handler: 'post-compaction-inject' },
    ];
    writeHooksConfig(workspace, configs);

    const engine = new HookEngine(workspace);
    expect(engine.configCount()).toBe(1);
  });

  test('reload() picks up config changes', () => {
    const engine = new HookEngine(workspace);
    expect(engine.configCount()).toBe(0);

    writeHooksConfig(workspace, [
      { event: 'after-edit', type: 'internal', handler: 'post-compaction-inject' },
    ]);
    engine.reload();
    expect(engine.configCount()).toBe(1);
  });

  test('gracefully handles malformed hooks.json', () => {
    const dir = path.join(workspace, '.bormagi', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks.json'), 'not json', 'utf-8');
    const engine = new HookEngine(workspace);
    expect(engine.configCount()).toBe(0);
  });
});

// ─── Built-in: protected-path-check ──────────────────────────────────────────

describe('HookEngine — protected-path-check', () => {
  let workspace: string;
  let engine: HookEngine;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    writeHooksConfig(workspace, [
      {
        event:   'before-tool',
        type:    'internal',
        handler: 'protected-path-check',
        tool:    'writeFile',
        match:   ['**/secrets/**', '**/.env'],
      },
    ]);
    engine = new HookEngine(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('blocks write to protected path matching **/.env', async () => {
    const result = await engine.onBeforeTool(
      'writeFile',
      { path: 'src/config/.env' },
      { mode: 'code' },
    );
    expect(result.allow).toBe(false);
    expect(result.messages?.some(m => m.includes('.env'))).toBe(true);
  });

  test('blocks write to path matching **/secrets/**', async () => {
    const result = await engine.onBeforeTool(
      'writeFile',
      { path: 'src/secrets/api-keys.ts' },
      { mode: 'code' },
    );
    expect(result.allow).toBe(false);
  });

  test('allows write to non-protected path', async () => {
    const result = await engine.onBeforeTool(
      'writeFile',
      { path: 'src/components/Button.tsx' },
      { mode: 'code' },
    );
    expect(result.allow).toBe(true);
  });

  test('does not fire for a different tool', async () => {
    const result = await engine.onBeforeTool(
      'readFile',
      { path: 'src/config/.env' },
      { mode: 'code' },
    );
    expect(result.allow).toBe(true);
  });
});

// ─── Built-in: post-compaction-inject ─────────────────────────────────────────

describe('HookEngine — post-compaction-inject', () => {
  let workspace: string;
  let engine: HookEngine;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
    writeHooksConfig(workspace, [
      {
        event:   'after-compaction',
        type:    'internal',
        handler: 'post-compaction-inject',
      },
    ]);
    engine = new HookEngine(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('allows the action and injects a context note', async () => {
    const result = await engine.onAfterCompaction({ mode: 'code' });
    expect(result.allow).toBe(true);
    expect(result.contextToInject).toBeDefined();
    expect(result.contextToInject!.length).toBeGreaterThan(0);
    expect(result.contextToInject![0]).toContain('compacted');
  });
});

// ─── After-edit glob filtering ────────────────────────────────────────────────

describe('HookEngine — after-edit glob filtering', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('hook fires when changed file matches glob', async () => {
    writeHooksConfig(workspace, [
      {
        event:   'after-edit',
        type:    'internal',
        handler: 'post-compaction-inject', // reuse as a simple allow hook
        match:   ['**/*.ts'],
      },
    ]);
    const engine = new HookEngine(workspace);
    const result = await engine.onAfterEdit(['src/foo.ts'], { mode: 'code' });
    expect(result.allow).toBe(true);
  });

  test('hook does not fire when no changed file matches glob', async () => {
    writeHooksConfig(workspace, [
      {
        event:   'after-edit',
        type:    'internal',
        handler: 'post-compaction-inject',
        match:   ['**/*.ts'],
      },
    ]);
    const engine = new HookEngine(workspace);
    // Pass only a JSON file — should not match *.ts
    const result = await engine.onAfterEdit(['src/config.json'], { mode: 'code' });
    // No matching hooks fire → default allow
    expect(result.allow).toBe(true);
    expect(result.contextToInject).toBeUndefined();
  });
});

// ─── Shell hooks ─────────────────────────────────────────────────────────────

describe('HookEngine — shell hooks', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('shell hook that exits 0 returns allow=true', async () => {
    writeHooksConfig(workspace, [
      {
        event:   'before-final',
        type:    'shell',
        command: 'echo "hook ran"',
      },
    ]);
    const engine = new HookEngine(workspace);
    const result = await engine.runHooks('before-final', { mode: 'plan' });
    expect(result.allow).toBe(true);
    expect(result.messages?.some(m => m.includes('hook ran'))).toBe(true);
  });

  test('shell hook that exits non-zero returns allow=false', async () => {
    writeHooksConfig(workspace, [
      {
        event:   'before-final',
        type:    'shell',
        command: 'exit 1',
      },
    ]);
    const engine = new HookEngine(workspace);
    const result = await engine.runHooks('before-final', { mode: 'plan' });
    expect(result.allow).toBe(false);
  });

  test('shell hook substitutes {{changedFiles}} template', async () => {
    const outFile = path.join(workspace, 'shell-output.txt');
    writeHooksConfig(workspace, [
      {
        event:   'after-edit',
        type:    'shell',
        command: `echo "{{changedFiles}}" > ${outFile}`,
      },
    ]);
    const engine = new HookEngine(workspace);
    await engine.onAfterEdit(['src/foo.ts', 'src/bar.ts'], { mode: 'code' });
    const output = fs.readFileSync(outFile, 'utf-8').trim();
    expect(output).toContain('src/foo.ts');
    expect(output).toContain('src/bar.ts');
  });
});

// ─── Event ordering and short-circuit ────────────────────────────────────────

describe('HookEngine — event ordering and short-circuit', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('stops at first blocking hook and does not run subsequent ones', async () => {
    const outFile = path.join(workspace, 'second-hook.txt');
    writeHooksConfig(workspace, [
      {
        event:   'before-tool',
        type:    'internal',
        handler: 'protected-path-check',
        tool:    'writeFile',
        match:   ['**/.env'],
      },
      {
        event:   'before-tool',
        type:    'shell',
        command: `echo "should not run" > ${outFile}`,
        tool:    'writeFile',
      },
    ]);
    const engine = new HookEngine(workspace);
    const result = await engine.onBeforeTool(
      'writeFile',
      { path: '.env' },
      { mode: 'code' },
    );
    expect(result.allow).toBe(false);
    expect(fs.existsSync(outFile)).toBe(false);
  });
});

// ─── getConfigs ───────────────────────────────────────────────────────────────

describe('HookEngine.getConfigs', () => {
  test('returns a copy of the loaded configs', () => {
    const workspace = makeTmpWorkspace();
    try {
      writeHooksConfig(workspace, [
        { event: 'session-start', type: 'internal', handler: 'post-compaction-inject' },
        { event: 'after-edit',    type: 'shell',    command: 'echo hi' },
      ]);
      const engine  = new HookEngine(workspace);
      const configs = engine.getConfigs();
      expect(configs).toHaveLength(2);
      expect(configs[0].event).toBe('session-start');
      expect(configs[1].event).toBe('after-edit');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
