// ─── Integration tests: Repo Map (IgnoreRules + LexicalSearch + RepoMapStore) ──
//
// These tests run against real filesystem operations using Node.js `fs` and a
// temporary directory.  They do NOT require a VS Code extension host.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { shouldExclude, detectLanguage, isSymbolIndexable } from '../../index/IgnoreRules';
import { extractImports, extractExports } from '../../index/SymbolExtractor';
import { saveRepoMap, loadRepoMap, isFresh, serializeRepoMapSlice } from '../../index/RepoMapStore';
import { searchRepoMap, importGraphNeighbors } from '../../retrieval/LexicalSearch';
import type { RepoMap, FileMapEntry } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-'));
}

function writeFile(dir: string, relPath: string, content = ''): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function makeEntry(overrides: Partial<FileMapEntry> = {}): FileMapEntry {
  return {
    path:      'src/foo.ts',
    language:  'typescript',
    exports:   [],
    imports:   [],
    symbols:   [],
    lineCount: 10,
    byteSize:  100,
    flags:     { generated: false, test: false, config: false, vendored: false, binary: false },
    ...overrides,
  };
}

function makeRepoMap(entries: FileMapEntry[]): RepoMap {
  return { repoRoot: '/workspace', generatedAtUtc: new Date().toISOString(), entries };
}

// ─── IgnoreRules ──────────────────────────────────────────────────────────────

describe('shouldExclude', () => {
  test('excludes node_modules', () => {
    expect(shouldExclude('node_modules/lodash/index.js')).toBe(true);
  });

  test('excludes .git directory', () => {
    expect(shouldExclude('.git/config')).toBe(true);
  });

  test('excludes binary file extensions', () => {
    expect(shouldExclude('media/icon.png')).toBe(true);
    expect(shouldExclude('dist/app.exe')).toBe(true);
  });

  test('excludes .bormagi directory', () => {
    expect(shouldExclude('.bormagi/repo-map.json')).toBe(true);
  });

  test('does not exclude regular source files', () => {
    expect(shouldExclude('src/index.ts')).toBe(false);
    expect(shouldExclude('src/components/Button.tsx')).toBe(false);
  });

  test('explicit user include overrides defaults', () => {
    expect(shouldExclude('node_modules/special/index.js', ['node_modules/special/index.js'])).toBe(false);
  });

  test('project ignore file is respected', () => {
    const tmpDir = makeTmpDir();
    const ignoreFile = path.join(tmpDir, '.bormagiignore');
    fs.writeFileSync(ignoreFile, 'src/generated/**\n', 'utf8');
    expect(shouldExclude('src/generated/client.ts', [], undefined, ignoreFile)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('project allowlist overrides built-in ignores', () => {
    const tmpDir = makeTmpDir();
    const allowlistFile = path.join(tmpDir, 'allowlist.json');
    fs.writeFileSync(allowlistFile, 'dist/shared.js\n', 'utf8');
    expect(shouldExclude('dist/shared.js', [], allowlistFile)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('detectLanguage', () => {
  test('detects TypeScript', () => expect(detectLanguage('foo.ts')).toBe('typescript'));
  test('detects TSX',        () => expect(detectLanguage('Bar.tsx')).toBe('typescript'));
  test('detects JavaScript', () => expect(detectLanguage('util.js')).toBe('javascript'));
  test('detects Python',     () => expect(detectLanguage('script.py')).toBe('python'));
  test('detects Java',       () => expect(detectLanguage('Main.java')).toBe('java'));
  test('falls back',         () => expect(detectLanguage('data.xyz')).toBe('plaintext'));
});

describe('isSymbolIndexable', () => {
  test('returns true for supported languages', () => {
    expect(isSymbolIndexable('typescript')).toBe(true);
    expect(isSymbolIndexable('javascript')).toBe(true);
    expect(isSymbolIndexable('python')).toBe(true);
    expect(isSymbolIndexable('java')).toBe(true);
  });

  test('returns false for unsupported languages', () => {
    expect(isSymbolIndexable('rust')).toBe(false);
    expect(isSymbolIndexable('plaintext')).toBe(false);
  });
});

// ─── SymbolExtractor (regex helpers only — no VS Code needed) ─────────────────

describe('extractImports', () => {
  test('extracts ES module imports', () => {
    const src = `import { foo } from './foo';\nimport bar from '../bar';`;
    const result = extractImports(src);
    expect(result).toContain('./foo');
    expect(result).toContain('../bar');
  });

  test('extracts require() calls', () => {
    const result = extractImports(`const x = require('lodash');`);
    expect(result).toContain('lodash');
  });

  test('returns empty array for file with no imports', () => {
    expect(extractImports('const x = 1;')).toEqual([]);
  });
});

describe('extractExports', () => {
  test('extracts named export functions', () => {
    const src = 'export function doSomething() {}\nexport const PI = 3.14;';
    const result = extractExports(src);
    expect(result).toContain('doSomething');
    expect(result).toContain('PI');
  });

  test('extracts export class', () => {
    expect(extractExports('export class MyService {}')).toContain('MyService');
  });

  test('returns empty for file with no exports', () => {
    expect(extractExports('const x = 1;')).toEqual([]);
  });
});

// ─── RepoMapStore ─────────────────────────────────────────────────────────────

describe('saveRepoMap / loadRepoMap', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('round-trips a repo map', () => {
    const original = makeRepoMap([makeEntry({ path: 'src/main.ts' })]);
    saveRepoMap(tmpDir, original);
    const loaded = loadRepoMap(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].path).toBe('src/main.ts');
  });

  test('loadRepoMap returns null when file absent', () => {
    expect(loadRepoMap(tmpDir)).toBeNull();
  });

  test('loadRepoMap returns null for corrupt JSON', () => {
    const bormagiDir = path.join(tmpDir, '.bormagi');
    fs.mkdirSync(bormagiDir, { recursive: true });
    fs.writeFileSync(path.join(bormagiDir, 'repo-map.json'), 'NOT JSON', 'utf8');
    expect(loadRepoMap(tmpDir)).toBeNull();
  });
});

describe('isFresh', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns true when mtime matches entry', () => {
    const filePath = writeFile(tmpDir, 'src/a.ts', 'const x = 1;');
    const stat = fs.statSync(filePath);
    const entry = makeEntry({ path: 'src/a.ts', lastModifiedUtc: stat.mtime.toISOString() });
    expect(isFresh(entry, filePath)).toBe(true);
  });

  test('returns false when mtime differs', () => {
    const filePath = writeFile(tmpDir, 'src/b.ts', 'const y = 2;');
    const entry = makeEntry({ path: 'src/b.ts', lastModifiedUtc: '2000-01-01T00:00:00.000Z' });
    expect(isFresh(entry, filePath)).toBe(false);
  });

  test('returns false when file does not exist', () => {
    const entry = makeEntry({ lastModifiedUtc: new Date().toISOString() });
    expect(isFresh(entry, '/nonexistent/path.ts')).toBe(false);
  });
});

describe('serializeRepoMapSlice', () => {
  test('produces non-empty output for a non-empty map', () => {
    const entry = makeEntry({ path: 'src/foo.ts', exports: ['Foo', 'Bar'], symbols: [] });
    const map = makeRepoMap([entry]);
    const result = serializeRepoMapSlice(map, { maxTokens: 1000 });
    expect(result).toContain('src/foo.ts');
  });

  test('respects maxTokens (output is roughly within budget)', () => {
    // Create 500 entries — more than can fit in a tiny budget.
    const entries = Array.from({ length: 500 }, (_, i) =>
      makeEntry({ path: `src/file${i}.ts` }),
    );
    const map = makeRepoMap(entries);
    const result = serializeRepoMapSlice(map, { maxTokens: 200 });
    // Rough check: result should not list all 500 files.
    const matches = (result.match(/src\/file/g) ?? []).length;
    expect(matches).toBeLessThan(500);
  });

  test('filterPaths restricts output to matching paths', () => {
    const entries = [
      makeEntry({ path: 'src/api/handler.ts' }),
      makeEntry({ path: 'src/ui/button.ts' }),
    ];
    const map = makeRepoMap(entries);
    const result = serializeRepoMapSlice(map, { maxTokens: 2000, filterPaths: ['src/api'] });
    expect(result).toContain('src/api/handler.ts');
    expect(result).not.toContain('src/ui/button.ts');
  });
});

// ─── LexicalSearch ────────────────────────────────────────────────────────────

describe('searchRepoMap', () => {
  const entries: FileMapEntry[] = [
    makeEntry({ path: 'src/auth/AuthService.ts',  exports: ['AuthService', 'login'], symbols: [] }),
    makeEntry({ path: 'src/user/UserRepository.ts', exports: ['UserRepository'], symbols: [] }),
    makeEntry({ path: 'tests/auth.test.ts', exports: [], symbols: [], flags: { generated: false, test: true, config: false, vendored: false, binary: false } }),
  ];
  const repoMap = makeRepoMap(entries);

  test('returns matches sorted by score', () => {
    const results = searchRepoMap(repoMap, 'auth service', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.path).toContain('auth');
  });

  test('returns empty array for query with no terms', () => {
    expect(searchRepoMap(repoMap, 'the a an', 10)).toEqual([]);
  });

  test('respects topK limit', () => {
    const results = searchRepoMap(repoMap, 'src', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('includes matchedTerms', () => {
    const results = searchRepoMap(repoMap, 'auth login', 5);
    const authMatch = results.find(r => r.entry.path.includes('AuthService'));
    expect(authMatch).toBeDefined();
    expect(authMatch!.matchedTerms.length).toBeGreaterThan(0);
  });
});

describe('importGraphNeighbors', () => {
  const entries: FileMapEntry[] = [
    makeEntry({ path: 'src/a.ts', imports: ['./b', './c'] }),
    makeEntry({ path: 'src/b.ts', imports: [] }),
    makeEntry({ path: 'src/c.ts', imports: ['./d'] }),
    makeEntry({ path: 'src/d.ts', imports: [] }),
  ];
  const repoMap = makeRepoMap(entries);

  test('returns direct imports (1 hop)', () => {
    const neighbors = importGraphNeighbors(repoMap, ['src/a.ts'], 1);
    const paths = neighbors.map(e => e.path);
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/c.ts');
    // d.ts is 2 hops away from a.ts
    expect(paths).not.toContain('src/d.ts');
  });

  test('follows 2 hops', () => {
    const neighbors = importGraphNeighbors(repoMap, ['src/a.ts'], 2);
    const paths = neighbors.map(e => e.path);
    expect(paths).toContain('src/d.ts');
  });

  test('does not include seed paths in result', () => {
    const neighbors = importGraphNeighbors(repoMap, ['src/a.ts'], 1);
    expect(neighbors.map(e => e.path)).not.toContain('src/a.ts');
  });
});
