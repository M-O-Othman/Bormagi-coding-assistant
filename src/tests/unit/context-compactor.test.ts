// ─── Unit tests: ContextCompactor ────────────────────────────────────────────
//
// Tests for the trigger threshold logic and the fallback/format helpers.
// The `compact()` function itself requires a live LLM provider, so those tests
// are in the integration suite.

import { shouldCompact, formatCompactedHistory } from '../../context/ContextCompactor';
import type { CompactedHistory, ModelProfile } from '../../context/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProfile(recommendedInputBudget: number): ModelProfile {
  return {
    provider:                    'anthropic',
    model:                       'claude-3-5-sonnet-20241022',
    maxContextTokens:            200_000,
    recommendedInputBudget,
    defaultMaxOutputTokens:      8192,
    supportsPromptCaching:       true,
    supportsToolUse:             true,
    estimatedToolOverheadTokens: 400,
    thresholds: {
      warnAtPct:      70,
      pruneAtPct:     80,
      compactAtPct:   85,
      emergencyAtPct: 95,
    },
  };
}

function makeHistory(): CompactedHistory {
  return {
    currentObjective:  'Implement the login feature.',
    decisions:         ['Use JWT for auth', 'Store refresh tokens in httpOnly cookies'],
    blockers:          ['CORS policy not yet confirmed'],
    recentActions:     ['Created AuthService.ts', 'Added /login route'],
    recentArtifacts:   ['src/auth/AuthService.ts', 'src/routes/auth.ts'],
    pendingNextSteps:  ['Write unit tests', 'Add rate limiting'],
    narrativeSummary:  'The assistant has implemented a basic JWT login flow.',
  };
}

// ─── shouldCompact ────────────────────────────────────────────────────────────

describe('shouldCompact', () => {
  const profile = makeProfile(100_000);

  test('returns false when history is well below threshold', () => {
    // 50 % of budget — well below the 80 % trigger
    expect(shouldCompact(50_000, profile, 10)).toBe(false);
  });

  test('returns true when history meets the threshold', () => {
    // Exactly at 80 % of 100k = 80_000
    expect(shouldCompact(80_000, profile, 10)).toBe(true);
  });

  test('returns true when history exceeds the threshold', () => {
    expect(shouldCompact(95_000, profile, 10)).toBe(true);
  });

  test('returns false when message count is too low (< 6)', () => {
    // Even with high tokens, don't compact a very short conversation.
    expect(shouldCompact(90_000, profile, 5)).toBe(false);
  });

  test('returns true at minimum message count (6)', () => {
    expect(shouldCompact(80_000, profile, 6)).toBe(true);
  });

  test('threshold scales with profile budget', () => {
    const smallProfile  = makeProfile(10_000);
    const largeProfile  = makeProfile(200_000);
    // 8_001 tokens: above 80 % of 10k but below 80 % of 200k
    expect(shouldCompact(8_001, smallProfile,  10)).toBe(true);
    expect(shouldCompact(8_001, largeProfile,  10)).toBe(false);
  });
});

// ─── formatCompactedHistory ───────────────────────────────────────────────────

describe('formatCompactedHistory', () => {
  test('includes the objective', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('Implement the login feature.');
  });

  test('lists decisions', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('Use JWT for auth');
    expect(result).toContain('Store refresh tokens in httpOnly cookies');
  });

  test('lists blockers', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('CORS policy not yet confirmed');
  });

  test('lists pending next steps', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('Write unit tests');
    expect(result).toContain('Add rate limiting');
  });

  test('lists recent artifacts', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('src/auth/AuthService.ts');
  });

  test('includes narrative summary', () => {
    const h = makeHistory();
    const result = formatCompactedHistory(h);
    expect(result).toContain('JWT login flow');
  });

  test('does not include empty sections when arrays are empty', () => {
    const h: CompactedHistory = {
      currentObjective:  'Just a simple task.',
      decisions:         [],
      blockers:          [],
      recentActions:     [],
      recentArtifacts:   [],
      pendingNextSteps:  [],
    };
    const result = formatCompactedHistory(h);
    expect(result).not.toContain('Decisions made');
    expect(result).not.toContain('Blockers');
    expect(result).not.toContain('Pending next steps');
    expect(result).not.toContain('Files changed');
  });

  test('includes the session-compacted header', () => {
    const result = formatCompactedHistory(makeHistory());
    expect(result).toContain('[Session compacted');
  });
});
