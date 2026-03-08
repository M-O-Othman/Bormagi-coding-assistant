// ─── Integration tests: InstructionResolver ───────────────────────────────────
//
// Verifies that resolveInstructions() correctly loads, merges, and token-caps
// instruction layers from the workspace filesystem.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveInstructions,
  ensureInstructionFile,
  INSTRUCTION_DIR,
  GLOBAL_INSTRUCTION,
  REPO_INSTRUCTION,
} from '../../context/InstructionResolver';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-instr-test-'));
}

function writeInstructionFile(
  workspaceRoot: string,
  filename: string,
  content: string,
): void {
  const dir = path.join(workspaceRoot, INSTRUCTION_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

// ─── resolveInstructions ──────────────────────────────────────────────────────

describe('resolveInstructions', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns empty merged string when no instruction files exist', () => {
    const result = resolveInstructions(tmpDir);
    expect(result.merged).toBe('');
    expect(result.totalTokenEstimate).toBe(0);
    expect(result.layers).toHaveLength(2);
  });

  test('marks missing layers correctly', () => {
    const result = resolveInstructions(tmpDir);
    const [global, repo] = result.layers;
    expect(global.missing).toBe(true);
    expect(repo.missing).toBe(true);
  });

  test('loads global.md when present', () => {
    writeInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'You are a helpful assistant.');
    const result = resolveInstructions(tmpDir);
    expect(result.merged).toContain('You are a helpful assistant.');
    expect(result.layers[0].missing).toBe(false);
    expect(result.layers[0].role).toBe('global');
  });

  test('loads repo.md when present', () => {
    writeInstructionFile(tmpDir, REPO_INSTRUCTION, 'Use tabs for indentation.');
    const result = resolveInstructions(tmpDir);
    expect(result.merged).toContain('Use tabs for indentation.');
    expect(result.layers[1].missing).toBe(false);
    expect(result.layers[1].role).toBe('repo');
  });

  test('merges both layers with separator', () => {
    writeInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'Global rules here.');
    writeInstructionFile(tmpDir, REPO_INSTRUCTION,   'Repo rules here.');
    const result = resolveInstructions(tmpDir);
    expect(result.merged).toContain('Global rules here.');
    expect(result.merged).toContain('Repo rules here.');
    expect(result.merged).toContain('---'); // separator
  });

  test('layer order is global before repo', () => {
    writeInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'GLOBAL');
    writeInstructionFile(tmpDir, REPO_INSTRUCTION,   'REPO');
    const result = resolveInstructions(tmpDir);
    const globalIdx = result.merged.indexOf('GLOBAL');
    const repoIdx   = result.merged.indexOf('REPO');
    expect(globalIdx).toBeLessThan(repoIdx);
  });

  test('truncates content when it exceeds token budget', () => {
    // Write a very large repo.md (> 2000 tokens ≈ 8000 chars).
    const bigContent = 'A'.repeat(12000);
    writeInstructionFile(tmpDir, REPO_INSTRUCTION, bigContent);
    const result = resolveInstructions(tmpDir);
    // Merged should be shorter than the raw content.
    expect(result.merged.length).toBeLessThan(bigContent.length);
    expect(result.merged).toContain('[truncated]');
  });

  test('totalTokenEstimate is non-zero when content is present', () => {
    writeInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'Some global instructions.');
    const result = resolveInstructions(tmpDir);
    expect(result.totalTokenEstimate).toBeGreaterThan(0);
  });

  test('layer filePath points to the correct absolute path', () => {
    const result = resolveInstructions(tmpDir);
    const [global, repo] = result.layers;
    expect(global.filePath).toContain(INSTRUCTION_DIR);
    expect(global.filePath).toContain(GLOBAL_INSTRUCTION);
    expect(repo.filePath).toContain(REPO_INSTRUCTION);
  });
});

// ─── ensureInstructionFile ────────────────────────────────────────────────────

describe('ensureInstructionFile', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('creates the file when it does not exist', () => {
    ensureInstructionFile(tmpDir, GLOBAL_INSTRUCTION, '# Global\nHello.');
    const filePath = path.join(tmpDir, INSTRUCTION_DIR, GLOBAL_INSTRUCTION);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Hello.');
  });

  test('does not overwrite an existing file', () => {
    writeInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'Original content.');
    ensureInstructionFile(tmpDir, GLOBAL_INSTRUCTION, 'New content.');
    const filePath = path.join(tmpDir, INSTRUCTION_DIR, GLOBAL_INSTRUCTION);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Original content.');
  });

  test('creates parent directories if needed', () => {
    ensureInstructionFile(tmpDir, REPO_INSTRUCTION, '# Repo');
    const dirPath = path.join(tmpDir, INSTRUCTION_DIR);
    expect(fs.existsSync(dirPath)).toBe(true);
  });
});
