// ─── Unit tests: BudgetEngine ──────────────────────────────────────────────────

import {
  checkBudget,
  estimateTokens,
  estimateEnvelopeTokens,
  enforcePreflightBudget,
} from '../../context/BudgetEngine';
import type { ModeBudget, ModelProfile, ContextEnvelope, ContextCandidate } from '../../context/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PROFILE: ModelProfile = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  maxContextTokens: 200_000,
  recommendedInputBudget: 180_000,
  defaultMaxOutputTokens: 8_000,
  supportsPromptCaching: true,
  supportsToolUse: true,
  estimatedToolOverheadTokens: 400,
  thresholds: {
    warnAtPct: 0.65,
    pruneAtPct: 0.75,
    compactAtPct: 0.82,
    emergencyAtPct: 0.90,
  },
};

const MOCK_BUDGET: ModeBudget = {
  stablePrefix: 1800,
  memory: 1200,
  repoMap: 1200,
  retrievedContext: 7000,
  toolOutputs: 1200,
  conversationTail: 1000,
  userInput: 800,
  reservedMargin: 3000,
};

function makeCandidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: 'c1',
    kind: 'file',
    content: 'x'.repeat(400),   // ~100 tokens
    tokenEstimate: 100,
    score: 0.8,
    reasons: [],
    editable: true,
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    editable: [],
    reference: [],
    memory: [],
    toolOutputs: [],
    ...overrides,
  };
}

// ─── checkBudget ──────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  test('returns fits=true when tokens are within soft limit', () => {
    const result = checkBudget(1000, MOCK_BUDGET, MOCK_PROFILE);
    expect(result.fits).toBe(true);
    expect(result.overflowBy).toBe(0);
    expect(result.actions).toEqual([]);
  });

  test('soft limit = recommendedInputBudget − reservedMargin', () => {
    const result = checkBudget(1000, MOCK_BUDGET, MOCK_PROFILE);
    expect(result.softLimit).toBe(180_000 - 3000);
    expect(result.hardLimit).toBe(180_000);
  });

  test('returns fits=false and ordered actions when over soft limit', () => {
    const overBudget = MOCK_PROFILE.recommendedInputBudget; // exceeds soft limit
    const result = checkBudget(overBudget, MOCK_BUDGET, MOCK_PROFILE);
    expect(result.fits).toBe(false);
    expect(result.overflowBy).toBeGreaterThan(0);
    expect(result.actions).toEqual([
      'prune-reference-snippets',
      'reduce-repo-map',
      'summarize-tool-outputs',
      'reduce-conversation-tail',
      'degrade-to-plan-only',
    ]);
  });

  test('overflowBy is 0 when fits=true', () => {
    expect(checkBudget(100, MOCK_BUDGET, MOCK_PROFILE).overflowBy).toBe(0);
  });

  test('overflowBy reflects correct excess when fits=false', () => {
    const softLimit = MOCK_PROFILE.recommendedInputBudget - MOCK_BUDGET.reservedMargin;
    const excess = 500;
    const result = checkBudget(softLimit + excess, MOCK_BUDGET, MOCK_PROFILE);
    expect(result.overflowBy).toBe(excess);
  });
});

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  test('estimates ~4 chars per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(Math.ceil(400 / 3.5));
  });

  test('rounds up for fractional tokens', () => {
    expect(estimateTokens('abc')).toBe(1);   // 3/4 → ceil → 1
    expect(estimateTokens('a'.repeat(5))).toBe(Math.ceil(5 / 3.5)); // 2
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ─── estimateEnvelopeTokens ───────────────────────────────────────────────────

describe('estimateEnvelopeTokens', () => {
  test('adds fixed budget slots to envelope token sum', () => {
    const envelope = makeEnvelope({
      editable: [makeCandidate({ tokenEstimate: 200 })],
      reference: [makeCandidate({ tokenEstimate: 100 })],
    });
    const result = estimateEnvelopeTokens(envelope, MOCK_BUDGET, MOCK_PROFILE);
    const expected =
      MOCK_BUDGET.stablePrefix +
      MOCK_BUDGET.userInput +
      MOCK_PROFILE.estimatedToolOverheadTokens +
      200 + 100; // envelope
    expect(result).toBe(expected);
  });

  test('empty envelope totals only fixed slots', () => {
    const result = estimateEnvelopeTokens(makeEnvelope(), MOCK_BUDGET, MOCK_PROFILE);
    expect(result).toBe(
      MOCK_BUDGET.stablePrefix + MOCK_BUDGET.userInput +
      MOCK_PROFILE.estimatedToolOverheadTokens,
    );
  });
});

// ─── enforcePreflightBudget ───────────────────────────────────────────────────

describe('enforcePreflightBudget', () => {
  test('returns unchanged envelope when already within budget', () => {
    const envelope = makeEnvelope();
    const { envelope: out, actionsApplied, degraded } = enforcePreflightBudget(
      envelope, MOCK_BUDGET, MOCK_PROFILE,
    );
    expect(actionsApplied).toEqual([]);
    expect(degraded).toBe(false);
    expect(out.editable).toEqual([]);
    expect(out.reference).toEqual([]);
  });

  test('does not mutate the original envelope', () => {
    const reference = [makeCandidate({ kind: 'snippet', tokenEstimate: 1000, score: 0.5 })];
    const envelope = makeEnvelope({ reference });
    // Push far over budget by adding 200 huge candidates
    const manyReference = Array.from({ length: 200 }, (_, i) =>
      makeCandidate({ id: `r${i}`, kind: 'snippet', tokenEstimate: 1000, score: 0.5 }),
    );
    const bigEnvelope = makeEnvelope({ reference: manyReference });
    enforcePreflightBudget(bigEnvelope, MOCK_BUDGET, MOCK_PROFILE);
    // Original should be untouched
    expect(bigEnvelope.reference).toHaveLength(200);
  });

  test('applies prune-reference-snippets when reference items are present and over budget', () => {
    // Fill reference with enough tokens to go over budget
    const reference = Array.from({ length: 200 }, (_, i) =>
      makeCandidate({ id: `r${i}`, kind: 'snippet', tokenEstimate: 1000, score: i * 0.01 }),
    );
    const envelope = makeEnvelope({ reference });
    const { actionsApplied, envelope: out } = enforcePreflightBudget(envelope, MOCK_BUDGET, MOCK_PROFILE);
    expect(actionsApplied).toContain('prune-reference-snippets');
    // Should have fewer reference items than we started with
    expect(out.reference.length).toBeLessThan(200);
  });

  test('sets degraded=true when degrade-to-plan-only is applied', () => {
    // Create an envelope that won't fit even after all softer remediations.
    // We achieve this by setting a tiny budget with huge token estimates.
    const tinyProfile: ModelProfile = {
      ...MOCK_PROFILE,
      recommendedInputBudget: 100,
    };
    const bigEnvelope = makeEnvelope({
      editable: Array.from({ length: 50 }, (_, i) => makeCandidate({ id: `e${i}`, tokenEstimate: 500 })),
      reference: Array.from({ length: 50 }, (_, i) => makeCandidate({ id: `r${i}`, kind: 'snippet', tokenEstimate: 500, score: 0.5 })),
      toolOutputs: Array.from({ length: 10 }, (_, i) => makeCandidate({ id: `t${i}`, kind: 'tool-output', tokenEstimate: 1000 })),
    });
    const { degraded } = enforcePreflightBudget(bigEnvelope, MOCK_BUDGET, tinyProfile);
    expect(degraded).toBe(true);
  });

  test('degrade-to-plan-only empties editable, reference, toolOutputs but keeps memory', () => {
    const tinyProfile: ModelProfile = { ...MOCK_PROFILE, recommendedInputBudget: 100 };
    const mem = makeCandidate({ id: 'm1', kind: 'memory', tokenEstimate: 5 });
    const bigEnvelope = makeEnvelope({
      editable: Array.from({ length: 50 }, (_, i) => makeCandidate({ id: `e${i}`, tokenEstimate: 500 })),
      reference: Array.from({ length: 50 }, (_, i) => makeCandidate({ id: `r${i}`, kind: 'snippet', tokenEstimate: 500, score: 0.5 })),
      toolOutputs: Array.from({ length: 10 }, (_, i) => makeCandidate({ id: `t${i}`, kind: 'tool-output', tokenEstimate: 1000 })),
      memory: [mem],
    });
    const { envelope: out } = enforcePreflightBudget(bigEnvelope, MOCK_BUDGET, tinyProfile);
    expect(out.editable).toEqual([]);
    expect(out.reference).toEqual([]);
    expect(out.toolOutputs).toEqual([]);
    expect(out.memory).toEqual([mem]);
  });
});
