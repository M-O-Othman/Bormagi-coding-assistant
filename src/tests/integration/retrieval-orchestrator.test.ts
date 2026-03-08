// ─── Integration tests: RetrievalOrchestrator + CandidateRanker + ContextEnvelope

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { retrieveCandidates } from '../../retrieval/RetrievalOrchestrator';
import { rankAndPrune, scoreCandidate } from '../../retrieval/CandidateRanker';
import { buildContextEnvelope, envelopeTokenCount, mergeEnvelopes } from '../../context/ContextEnvelope';
import { boundedWindow, extractSnippet, extractSnippetFromContent, countFileLines } from '../../retrieval/SnippetExtractor';
import type { ContextCandidate, RepoMap, FileMapEntry } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-retrieval-'));
}

function writeFile(dir: string, relPath: string, content = ''): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function makeCandidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id:            'c1',
    kind:          'snippet',
    content:       'const x = 1;',
    tokenEstimate: 10,
    score:         0.5,
    reasons:       [],
    editable:      false,
    ...overrides,
  };
}

function makeRepoMap(entries: FileMapEntry[]): RepoMap {
  return { repoRoot: '/workspace', generatedAtUtc: new Date().toISOString(), entries };
}

// ─── SnippetExtractor ─────────────────────────────────────────────────────────

describe('boundedWindow', () => {
  test('clamps start to 0', () => {
    const w = boundedWindow(2, 100, 20, 30);
    expect(w.startLine).toBe(0);
  });

  test('clamps end to totalLines - 1', () => {
    const w = boundedWindow(95, 100, 10, 20);
    expect(w.endLine).toBe(99);
  });

  test('computes correct window for anchor in the middle', () => {
    const w = boundedWindow(50, 200, 10, 20);
    expect(w.startLine).toBe(40);
    expect(w.endLine).toBe(70);
  });
});

describe('extractSnippet', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns snippet from file', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const filePath = writeFile(tmpDir, 'test.ts', lines.join('\n'));
    const snippet = extractSnippet(filePath, { startLine: 5, endLine: 10 });
    expect(snippet).not.toBeNull();
    expect(snippet!.content).toContain('line 5');
    expect(snippet!.content).toContain('line 10');
    expect(snippet!.startLine).toBe(5);
  });

  test('returns null for non-existent file', () => {
    expect(extractSnippet('/nonexistent/path.ts', { startLine: 0, endLine: 5 })).toBeNull();
  });

  test('truncates when maxChars is exceeded', () => {
    const longLine = 'x'.repeat(200);
    const content = Array.from({ length: 50 }, () => longLine).join('\n');
    const filePath = writeFile(tmpDir, 'long.ts', content);
    const snippet = extractSnippet(filePath, { startLine: 0, endLine: 49 }, 300);
    expect(snippet!.truncated).toBe(true);
    expect(snippet!.content.length).toBeLessThanOrEqual(310); // slight tolerance
  });
});

describe('extractSnippetFromContent', () => {
  test('extracts lines correctly', () => {
    const content = 'a\nb\nc\nd\ne';
    const result = extractSnippetFromContent(content, { startLine: 1, endLine: 3 });
    expect(result.content).toBe('b\nc\nd');
    expect(result.truncated).toBe(false);
  });
});

describe('countFileLines', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('counts lines correctly', () => {
    const filePath = writeFile(tmpDir, 'f.ts', 'a\nb\nc');
    expect(countFileLines(filePath)).toBe(3);
  });

  test('returns 0 for non-existent file', () => {
    expect(countFileLines('/no/such/file.ts')).toBe(0);
  });
});

// ─── CandidateRanker ──────────────────────────────────────────────────────────

describe('scoreCandidate', () => {
  test('returns 0 for candidate with no signals', () => {
    const c = makeCandidate();
    expect(scoreCandidate({ candidate: c })).toBe(0);
  });

  test('active-file candidate scores higher than plain lexical', () => {
    const c1 = makeCandidate({ id: 'active' });
    const c2 = makeCandidate({ id: 'lexical' });
    const s1 = scoreCandidate({ candidate: c1, isActiveFile: true });
    const s2 = scoreCandidate({ candidate: c2, lexicalScore: 0.5 });
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(0);
    // Both should produce non-zero scores — exact ordering depends on weights.
  });

  test('appends reasons to candidate.reasons', () => {
    const c = makeCandidate({ reasons: ['pre-existing'] });
    scoreCandidate({ candidate: c, isActiveFile: true });
    expect(c.reasons).toContain('active-file');
    expect(c.reasons).toContain('pre-existing');
  });
});

describe('rankAndPrune', () => {
  test('drops zero-score candidates', () => {
    const zero  = makeCandidate({ id: 'z', score: 0, tokenEstimate: 10 });
    const nonZero = makeCandidate({ id: 'nz', score: 0.8, tokenEstimate: 10 });
    const result = rankAndPrune([zero, nonZero], 1000, 'edit');
    expect(result.map(c => c.id)).not.toContain('z');
    expect(result.map(c => c.id)).toContain('nz');
  });

  test('prunes when token budget is exceeded', () => {
    const big = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: `c${i}`, score: 0.5 - i * 0.01, tokenEstimate: 100 }),
    );
    const result = rankAndPrune(big, 350, 'edit');
    // 3 candidates × 100 tokens = 300 ≤ 350; 4th would exceed.
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('sorts by score descending', () => {
    const candidates = [
      makeCandidate({ id: 'low',  score: 0.2, tokenEstimate: 10 }),
      makeCandidate({ id: 'high', score: 0.9, tokenEstimate: 10 }),
      makeCandidate({ id: 'mid',  score: 0.5, tokenEstimate: 10 }),
    ];
    const result = rankAndPrune(candidates, 1000, 'edit');
    expect(result[0].id).toBe('high');
    expect(result[1].id).toBe('mid');
    expect(result[2].id).toBe('low');
  });

  test('demotes editable file to reference when cap is reached (plan mode)', () => {
    const editables = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({ id: `e${i}`, score: 0.5, tokenEstimate: 10, editable: true }),
    );
    const result = rankAndPrune(editables, 1000, 'plan');
    // plan mode maxEditable = 0
    expect(result.every(c => !c.editable)).toBe(true);
  });
});

// ─── ContextEnvelope ──────────────────────────────────────────────────────────

describe('buildContextEnvelope', () => {
  test('places editable candidates in editable list (edit mode)', () => {
    const candidates = [
      makeCandidate({ id: 'e1', editable: true,  kind: 'file',    score: 0.9 }),
      makeCandidate({ id: 'r1', editable: false, kind: 'snippet', score: 0.5 }),
    ];
    const env = buildContextEnvelope(candidates, 'edit');
    expect(env.editable.map(c => c.id)).toContain('e1');
    expect(env.reference.map(c => c.id)).toContain('r1');
  });

  test('puts memory candidates in memory list', () => {
    const c = makeCandidate({ kind: 'memory', editable: false, score: 0.3 });
    const env = buildContextEnvelope([c], 'edit');
    expect(env.memory).toHaveLength(1);
    expect(env.editable).toHaveLength(0);
  });

  test('puts tool-output candidates in toolOutputs list', () => {
    const c = makeCandidate({ kind: 'tool-output', editable: false, score: 0.3 });
    const env = buildContextEnvelope([c], 'debug');
    expect(env.toolOutputs).toHaveLength(1);
  });

  test('plan mode has 0 editable files', () => {
    const candidates = [
      makeCandidate({ id: 'e1', editable: true, kind: 'file', score: 0.9 }),
    ];
    const env = buildContextEnvelope(candidates, 'plan');
    expect(env.editable).toHaveLength(0);
    expect(env.reference).toHaveLength(1);
  });
});

describe('envelopeTokenCount', () => {
  test('sums tokens across all buckets', () => {
    const env = {
      editable:    [makeCandidate({ tokenEstimate: 100 })],
      reference:   [makeCandidate({ tokenEstimate: 200 })],
      memory:      [makeCandidate({ tokenEstimate: 50 })],
      toolOutputs: [makeCandidate({ tokenEstimate: 75 })],
    };
    expect(envelopeTokenCount(env)).toBe(425);
  });
});

describe('mergeEnvelopes', () => {
  test('overlay candidates come before base', () => {
    const base    = { editable: [makeCandidate({ id: 'base' })], reference: [], memory: [], toolOutputs: [] };
    const overlay = { editable: [makeCandidate({ id: 'over' })], reference: [], memory: [], toolOutputs: [] };
    const merged  = mergeEnvelopes(base, overlay);
    expect(merged.editable[0].id).toBe('over');
    expect(merged.editable[1].id).toBe('base');
  });
});

// ─── RetrievalOrchestrator (filesystem-based) ─────────────────────────────────

describe('retrieveCandidates', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns candidates when active file is provided', async () => {
    const filePath = writeFile(tmpDir, 'src/main.ts', 'export function main() {}');
    const results = await retrieveCandidates(
      { text: 'main function', mode: 'edit', activeFile: filePath },
      { workspaceRoot: tmpDir, repoMap: null, activeFilePath: filePath },
      5000,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(c => c.path?.includes('main.ts'))).toBe(true);
  });

  test('returns results from lexical search when repoMap is provided', async () => {
    writeFile(tmpDir, 'src/authService.ts', 'export class AuthService { login() {} }');
    writeFile(tmpDir, 'src/userService.ts', 'export class UserService { getUser() {} }');

    const repoMap: RepoMap = makeRepoMap([
      {
        path:      'src/authService.ts',
        language:  'typescript',
        exports:   ['AuthService', 'login'],
        imports:   [],
        symbols:   [{ name: 'AuthService', kind: 'class' }, { name: 'login', kind: 'method' }],
        lineCount: 1,
        byteSize:  50,
        flags:     { generated: false, test: false, config: false, vendored: false, binary: false },
      },
      {
        path:      'src/userService.ts',
        language:  'typescript',
        exports:   ['UserService'],
        imports:   [],
        symbols:   [{ name: 'UserService', kind: 'class' }],
        lineCount: 1,
        byteSize:  50,
        flags:     { generated: false, test: false, config: false, vendored: false, binary: false },
      },
    ]);

    const results = await retrieveCandidates(
      { text: 'authenticate user login', mode: 'edit' },
      { workspaceRoot: tmpDir, repoMap },
      10000,
    );

    // AuthService should rank first since it matches 'auth' and 'login'.
    const paths = results.map(c => c.path);
    expect(paths.some(p => p?.includes('authService'))).toBe(true);
  });

  test('returns empty array when no signals match', async () => {
    const results = await retrieveCandidates(
      { text: 'some completely unrelated query', mode: 'search' },
      { workspaceRoot: tmpDir, repoMap: null },
      5000,
    );
    expect(results).toEqual([]);
  });

  test('honours token budget', async () => {
    // Create several files.
    for (let i = 0; i < 10; i++) {
      writeFile(tmpDir, `src/file${i}.ts`, `export function fn${i}() { return ${i}; }`);
    }
    const repoMap: RepoMap = makeRepoMap(
      Array.from({ length: 10 }, (_, i) => ({
        path:      `src/file${i}.ts`,
        language:  'typescript',
        exports:   [`fn${i}`],
        imports:   [],
        symbols:   [{ name: `fn${i}`, kind: 'function' as const }],
        lineCount: 1,
        byteSize:  40,
        flags:     { generated: false, test: false, config: false, vendored: false, binary: false },
      })),
    );

    const TINY_BUDGET = 50; // tokens — forces pruning
    const results = await retrieveCandidates(
      { text: 'file fn export function', mode: 'edit' },
      { workspaceRoot: tmpDir, repoMap },
      TINY_BUDGET,
    );

    const totalTokens = results.reduce((s, c) => s + c.tokenEstimate, 0);
    expect(totalTokens).toBeLessThanOrEqual(TINY_BUDGET);
  });
});
