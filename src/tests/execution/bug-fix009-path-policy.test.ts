/**
 * bug-fix009: PathPolicy tests — internal runtime path blocking.
 */
import {
  isInternalRuntimePath,
  canAgentReadPath,
  canAgentWritePath,
  getPathBlockReason,
} from '../../agents/PathPolicy';

describe('PathPolicy — internal path blocking (bug-fix-009 Fix 1.4)', () => {
  // ── isInternalRuntimePath ───────────────────────────────────────────────────
  describe('isInternalRuntimePath', () => {
    test('.bormagi/ prefix is internal', () => {
      expect(isInternalRuntimePath('.bormagi/logs/advanced-coder.log')).toBe(true);
    });

    test('.bormagi root is internal', () => {
      expect(isInternalRuntimePath('.bormagi')).toBe(true);
    });

    test('.git/ prefix is internal', () => {
      expect(isInternalRuntimePath('.git/config')).toBe(true);
    });

    test('.git root is internal', () => {
      expect(isInternalRuntimePath('.git')).toBe(true);
    });

    test('backslash-separated .bormagi path is internal', () => {
      expect(isInternalRuntimePath('.bormagi\\logs\\file.log')).toBe(true);
    });

    test('normal source files are NOT internal', () => {
      expect(isInternalRuntimePath('src/index.ts')).toBe(false);
      expect(isInternalRuntimePath('backend/app.py')).toBe(false);
      expect(isInternalRuntimePath('requirements.txt')).toBe(false);
      expect(isInternalRuntimePath('package.json')).toBe(false);
    });

    test('gitignore file itself is NOT internal (.git/ not .gitignore)', () => {
      expect(isInternalRuntimePath('.gitignore')).toBe(false);
    });

    test('bormagi.config.json is NOT internal (no leading .bormagi/)', () => {
      expect(isInternalRuntimePath('bormagi.config.json')).toBe(false);
    });
  });

  // ── canAgentReadPath ────────────────────────────────────────────────────────
  describe('canAgentReadPath', () => {
    test('blocks .bormagi in normal mode', () => {
      expect(canAgentReadPath('.bormagi/logs/agent.log')).toBe(false);
      expect(canAgentReadPath('.bormagi/logs/agent.log', 'normal')).toBe(false);
    });

    test('blocks .git in normal mode', () => {
      expect(canAgentReadPath('.git/config')).toBe(false);
    });

    test('allows .bormagi in internal_debug mode', () => {
      expect(canAgentReadPath('.bormagi/logs/agent.log', 'internal_debug')).toBe(true);
    });

    test('allows normal source files in all modes', () => {
      expect(canAgentReadPath('src/main.ts')).toBe(true);
      expect(canAgentReadPath('src/main.ts', 'internal_debug')).toBe(true);
    });
  });

  // ── canAgentWritePath ───────────────────────────────────────────────────────
  describe('canAgentWritePath', () => {
    test('blocks .bormagi writes always', () => {
      expect(canAgentWritePath('.bormagi/state.json')).toBe(false);
    });

    test('blocks .git writes always', () => {
      expect(canAgentWritePath('.git/config')).toBe(false);
    });

    test('allows normal file writes', () => {
      expect(canAgentWritePath('backend/app.py')).toBe(true);
    });
  });

  // ── getPathBlockReason ──────────────────────────────────────────────────────
  describe('getPathBlockReason', () => {
    test('returns reason string for internal path', () => {
      const reason = getPathBlockReason('.bormagi/logs/agent.log');
      expect(reason).toBeDefined();
      expect(reason).toContain('.bormagi/logs/agent.log');
    });

    test('returns undefined for allowed path', () => {
      expect(getPathBlockReason('src/index.ts')).toBeUndefined();
    });
  });
});
