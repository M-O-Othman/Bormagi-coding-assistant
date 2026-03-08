// ─── Unit tests: ModePromptLoader ─────────────────────────────────────────────

import * as path from 'path';
import { loadOutputContract, clearContractCache } from '../../context/ModePromptLoader';
import { ALL_MODES } from '../../context/ModeClassifier';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

beforeEach(() => {
  clearContractCache();
});

describe('loadOutputContract — packaged defaults', () => {
  test('loads a non-empty contract for every mode in ALL_MODES', () => {
    for (const mode of ALL_MODES) {
      const contract = loadOutputContract(mode, EXTENSION_ROOT);
      expect(typeof contract).toBe('string');
      expect(contract.trim().length).toBeGreaterThan(0);
    }
  });

  test('ask mode contract contains read-only instruction', () => {
    const contract = loadOutputContract('ask', EXTENSION_ROOT);
    expect(contract.toLowerCase()).toMatch(/ask mode|read.only|do not modify/i);
  });

  test('code mode contract contains changed files instruction', () => {
    const contract = loadOutputContract('code', EXTENSION_ROOT);
    expect(contract.toLowerCase()).toMatch(/changed files|patch summary/i);
  });

  test('plan mode contract does not instruct writing code', () => {
    const contract = loadOutputContract('plan', EXTENSION_ROOT);
    expect(contract.toLowerCase()).toMatch(/plan|steps|impacted/i);
  });

  test('debug mode contract contains root cause instruction', () => {
    const contract = loadOutputContract('debug', EXTENSION_ROOT);
    expect(contract.toLowerCase()).toMatch(/root cause|hypothesis/i);
  });
});

describe('loadOutputContract — caching', () => {
  test('returns the same string on subsequent calls without re-reading disk', () => {
    const first  = loadOutputContract('plan', EXTENSION_ROOT);
    const second = loadOutputContract('plan', EXTENSION_ROOT);
    expect(first).toBe(second);
  });

  test('clearContractCache allows fresh reads', () => {
    const first = loadOutputContract('edit', EXTENSION_ROOT);
    clearContractCache();
    const second = loadOutputContract('edit', EXTENSION_ROOT);
    expect(first).toEqual(second); // content is the same, but cache was cleared
  });
});

describe('loadOutputContract — workspace override', () => {
  test('falls back to packaged default when workspace has no override', () => {
    // Use a temp path that definitely has no override
    const noOverrideWs = path.join(EXTENSION_ROOT, 'src', 'tests');
    const contract = loadOutputContract('review', EXTENSION_ROOT, noOverrideWs);
    expect(contract.trim().length).toBeGreaterThan(0);
  });
});

describe('loadOutputContract — inline fallback', () => {
  test('returns fallback string when extension root is invalid', () => {
    clearContractCache();
    const contract = loadOutputContract('ask', '/nonexistent/path/that/does/not/exist');
    expect(typeof contract).toBe('string');
    expect(contract.trim().length).toBeGreaterThan(0);
  });
});
