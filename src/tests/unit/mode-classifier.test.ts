// ─── Unit tests: ModeClassifier ───────────────────────────────────────────────

import { classifyMode, buildUserModeDecision, ALL_MODES, MODE_LABELS } from '../../context/ModeClassifier';

describe('classifyMode', () => {
  describe('strong signals', () => {
    test('detects debug mode from "fix"', () => {
      const result = classifyMode('fix the null reference error in UserService');
      expect(result.mode).toBe('debug');
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.userOverride).toBe(false);
    });

    test('detects debug mode from "bug"', () => {
      expect(classifyMode('there is a bug in the payment flow').mode).toBe('debug');
    });

    test('detects debug mode from "stacktrace"', () => {
      expect(classifyMode('here is the stacktrace from the crash').mode).toBe('debug');
    });

    test('detects test-fix mode from "failing test"', () => {
      expect(classifyMode('the failing test in auth.spec.ts').mode).toBe('test-fix');
    });

    test('detects test-fix mode from "jest"', () => {
      expect(classifyMode('jest is reporting 3 failures').mode).toBe('test-fix');
    });

    test('detects plan mode from "architect"', () => {
      expect(classifyMode('architect a new authentication system').mode).toBe('plan');
    });

    test('detects plan mode from "what approach"', () => {
      expect(classifyMode('what approach should we use for state management').mode).toBe('plan');
    });

    test('detects review mode from "code review"', () => {
      expect(classifyMode('code review this pull request').mode).toBe('review');
    });

    test('detects review mode from "security audit"', () => {
      expect(classifyMode('security audit the authentication module').mode).toBe('review');
    });

    test('detects search mode from "find"', () => {
      expect(classifyMode('find the function that handles JWT decoding').mode).toBe('search');
    });

    test('detects search mode from "where is"', () => {
      expect(classifyMode('where is the database connection configured').mode).toBe('search');
    });

    test('detects explain mode from "explain"', () => {
      expect(classifyMode('explain how the context pipeline works').mode).toBe('explain');
    });

    test('detects explain mode from "what does"', () => {
      expect(classifyMode('what does the BudgetEngine do').mode).toBe('explain');
    });

    test('detects edit mode from "refactor"', () => {
      expect(classifyMode('refactor the TokenService to use the new API').mode).toBe('edit');
    });

    test('detects edit mode from "implement"', () => {
      expect(classifyMode('implement a new caching layer').mode).toBe('edit');
    });
  });

  describe('weak signals only', () => {
    test('still assigns a mode with reasonable confidence', () => {
      const result = classifyMode('why is this returning wrong values');
      expect(result.mode).toBeDefined();
      // weak match should still produce a score
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('no signals — default fallback', () => {
    test('returns edit mode with 0.3 confidence for unrecognised input', () => {
      const result = classifyMode('hello world');
      expect(result.mode).toBe('edit');
      expect(result.confidence).toBe(0.3);
      expect(result.secondaryIntents).toEqual([]);
    });
  });

  describe('secondary intents', () => {
    test('returns secondaryIntents when multiple modes are signalled', () => {
      // "find" signals search; "fix" signals debug
      const result = classifyMode('find and fix the broken authentication test');
      expect(result.secondaryIntents.length).toBeGreaterThan(0);
    });
  });

  describe('confidence capping', () => {
    test('confidence never exceeds 0.95', () => {
      const result = classifyMode('fix the critical production crash error stacktrace regression failing');
      expect(result.confidence).toBeLessThanOrEqual(0.95);
    });
  });

  describe('case insensitivity', () => {
    test('matches uppercase keywords', () => {
      expect(classifyMode('EXPLAIN how this works').mode).toBe('explain');
    });
  });
});

describe('buildUserModeDecision', () => {
  test('returns confidence 1.0 and userOverride true', () => {
    const result = buildUserModeDecision('plan');
    expect(result.mode).toBe('plan');
    expect(result.confidence).toBe(1.0);
    expect(result.userOverride).toBe(true);
    expect(result.secondaryIntents).toEqual([]);
  });

  test('works for all modes', () => {
    for (const mode of ALL_MODES) {
      const result = buildUserModeDecision(mode);
      expect(result.mode).toBe(mode);
      expect(result.userOverride).toBe(true);
    }
  });
});

describe('ALL_MODES', () => {
  test('contains exactly 7 modes', () => {
    expect(ALL_MODES).toHaveLength(7);
  });

  test('contains expected modes', () => {
    expect(ALL_MODES).toContain('plan');
    expect(ALL_MODES).toContain('edit');
    expect(ALL_MODES).toContain('debug');
    expect(ALL_MODES).toContain('test-fix');
  });
});

describe('MODE_LABELS', () => {
  test('has a label for every mode in ALL_MODES', () => {
    for (const mode of ALL_MODES) {
      expect(MODE_LABELS[mode]).toBeDefined();
      expect(typeof MODE_LABELS[mode]).toBe('string');
    }
  });
});
