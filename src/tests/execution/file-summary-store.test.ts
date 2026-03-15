/**
 * Tests for DD7: FileSummaryStore — hash-based file summary cache.
 */
import { FileSummaryStore } from '../../agents/execution/FileSummaryStore';

describe('FileSummaryStore', () => {
  test('put() stores and returns a ResolvedInputSummary', () => {
    const store = new FileSummaryStore();
    const result = store.put('src/index.ts', 'console.log("hello")', 'Entry point');
    expect(result.path).toBe('src/index.ts');
    expect(result.hash).toBeTruthy();
    expect(result.summary).toBe('Entry point');
    expect(result.kind).toBe('source');
    expect(result.lastReadAt).toBeTruthy();
  });

  test('get() returns entry when hash matches', () => {
    const store = new FileSummaryStore();
    const content = 'console.log("hello")';
    store.put('src/index.ts', content, 'Entry point');
    const hash = FileSummaryStore.hashContent(content);
    const result = store.get('src/index.ts', hash);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Entry point');
  });

  test('get() returns null when hash does not match', () => {
    const store = new FileSummaryStore();
    store.put('src/index.ts', 'old content', 'Old summary');
    const newHash = FileSummaryStore.hashContent('new content');
    expect(store.get('src/index.ts', newHash)).toBeNull();
  });

  test('get() returns null for unknown path', () => {
    const store = new FileSummaryStore();
    expect(store.get('unknown.ts', 'abc')).toBeNull();
  });

  test('getByPath() returns entry regardless of hash', () => {
    const store = new FileSummaryStore();
    store.put('src/index.ts', 'content', 'Summary');
    const result = store.getByPath('src/index.ts');
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Summary');
  });

  test('getByPath() returns null for unknown path', () => {
    const store = new FileSummaryStore();
    expect(store.getByPath('nope.ts')).toBeNull();
  });

  test('has() returns true for known paths', () => {
    const store = new FileSummaryStore();
    store.put('src/index.ts', 'content', 'Summary');
    expect(store.has('src/index.ts')).toBe(true);
    expect(store.has('other.ts')).toBe(false);
  });

  test('getAll() returns all stored summaries', () => {
    const store = new FileSummaryStore();
    store.put('a.ts', 'aaa', 'A');
    store.put('b.ts', 'bbb', 'B');
    expect(store.getAll()).toHaveLength(2);
  });

  test('clear() removes all entries', () => {
    const store = new FileSummaryStore();
    store.put('a.ts', 'content', 'A');
    store.clear();
    expect(store.has('a.ts')).toBe(false);
    expect(store.getAll()).toHaveLength(0);
  });

  test('summary is truncated to 500 chars', () => {
    const store = new FileSummaryStore();
    const longSummary = 'x'.repeat(1000);
    const result = store.put('test.ts', 'content', longSummary);
    expect(result.summary.length).toBe(500);
  });

  test('classifyKind() classifies file types correctly', () => {
    expect(FileSummaryStore.classifyKind('requirements.md')).toBe('requirements');
    expect(FileSummaryStore.classifyKind('spec.md')).toBe('requirements');
    expect(FileSummaryStore.classifyKind('plan.md')).toBe('plan');
    expect(FileSummaryStore.classifyKind('package.json')).toBe('config');
    expect(FileSummaryStore.classifyKind('tsconfig.json')).toBe('config');
    expect(FileSummaryStore.classifyKind('src/app.ts')).toBe('source');
    expect(FileSummaryStore.classifyKind('src/app.py')).toBe('source');
    expect(FileSummaryStore.classifyKind('README.md')).toBe('other');
    expect(FileSummaryStore.classifyKind('image.png')).toBe('other');
  });

  test('hashContent() produces consistent hashes', () => {
    const hash1 = FileSummaryStore.hashContent('hello world');
    const hash2 = FileSummaryStore.hashContent('hello world');
    const hash3 = FileSummaryStore.hashContent('different');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1.length).toBe(16); // truncated to 16 hex chars
  });

  test('put() overwrites existing entry for same path', () => {
    const store = new FileSummaryStore();
    store.put('src/index.ts', 'old', 'Old summary');
    store.put('src/index.ts', 'new', 'New summary');
    expect(store.getByPath('src/index.ts')!.summary).toBe('New summary');
    expect(store.getAll()).toHaveLength(1);
  });
});
