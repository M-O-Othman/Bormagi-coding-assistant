// ─── Mode Classifier ──────────────────────────────────────────────────────────
//
// Rules-based request classifier with optional LLM-based override.
//
// The user selects mode explicitly via the status bar dropdown (OQ-1 answer: C).
// This classifier is the auto-detect fallback used when no explicit selection
// has been made for the current request.
//
// When a classifierProvider is configured in project settings, classifyModeWithLLM()
// is used instead of the regex rules — the secondary model returns a single mode
// token with no streaming overhead.
// Spec reference: §FR-1.

import type { AssistantMode, ModeDecision } from './types';
import type { ILLMProvider } from '../providers/ILLMProvider';

// ─── Pattern table ────────────────────────────────────────────────────────────

interface ModePattern {
  mode: AssistantMode;
  /** Whole-word patterns that strongly signal this mode. Weight: 1.0 */
  strong: RegExp[];
  /** Patterns that weakly suggest this mode. Weight: 0.5 */
  weak: RegExp[];
}

const MODE_PATTERNS: ModePattern[] = [
  {
    mode: 'debug',
    strong: [
      /\b(fix|fixing|broken|break|breaks|bug|bugs|error|errors|exception|crash|crashing|failing|failed|stacktrace|stack\s*trace|traceback|undefined\s*is\s*not|cannot\s*read|null\s*reference|regression)\b/i,
    ],
    weak: [
      /\b(wrong|incorrect|unexpected|why\s+is|why\s+does|not\s+working|doesn'?t\s+work)\b/i,
    ],
  },
  {
    mode: 'test-fix',
    strong: [
      /\b(test\s*fail|failing\s*test|jest|mocha|vitest|pytest|junit|spec\s+fail|red\s+test|fix\s+test|make\s+test\s+pass)\b/i,
    ],
    weak: [
      /\b(test|spec|assertion|assert|expect\b)\b/i,
    ],
  },
  {
    mode: 'plan',
    strong: [
      /\b(plan|design|architect|architecture|how\s+should|what\s+files|which\s+files|what\s+approach|strategy|diagram|sketch|outline\s+the|proposal)\b/i,
    ],
    weak: [
      /\b(think\s+about|consider|structure|organise|organize|approach)\b/i,
    ],
  },
  {
    mode: 'review',
    strong: [
      /\b(review|code\s+review|pr\s+review|pull\s+request|lgtm|feedback\s+on|check\s+(this|my|the)\s+code|look\s+(at|over)\s+(this|my|the)|security\s+audit|audit\b)\b/i,
    ],
    weak: [
      /\b(check|verify|validate|assess|evaluate)\b/i,
    ],
  },
  {
    mode: 'search',
    strong: [
      /\b(find|search|locate|where\s+is|where\s+are|grep\s+for|look\s+for|which\s+file|what\s+file)\b/i,
    ],
    weak: [
      /\b(show\s+me|list\s+(all|every)|enumerate)\b/i,
    ],
  },
  {
    mode: 'explain',
    strong: [
      /\b(explain|what\s+does|how\s+does|describe|what\s+is\s+(this|the)|tell\s+me\s+about|walk\s+me\s+through|clarify|understand)\b/i,
    ],
    weak: [
      /\b(why\s+is|what\s+are|overview|summary\s+of)\b/i,
    ],
  },
  {
    mode: 'edit',
    strong: [
      /\b(edit|change|refactor|rename|move|update|rewrite|implement|add\s+(a|the|new)\s+\w+|remove|delete|replace|modify|create\s+(a|the|new)\s+(function|class|method|file|component|interface|type))\b/i,
    ],
    weak: [
      /\b(make\s+it|convert|transform|migrate|improve|extend|add|inject)\b/i,
    ],
  },
];

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreText(text: string, pattern: ModePattern): number {
  let score = 0;
  for (const re of pattern.strong) { if (re.test(text)) { score += 1.0; } }
  for (const re of pattern.weak)   { if (re.test(text)) { score += 0.5; } }
  return score;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-detect the `AssistantMode` for a given user text.
 *
 * Returns a `ModeDecision` with `userOverride: false`.
 * Callers that have an explicit user selection should set `userOverride: true`
 * and bypass this function entirely.
 */
export function classifyMode(userText: string): ModeDecision {
  const scores: Array<{ mode: AssistantMode; score: number }> = [];

  for (const pattern of MODE_PATTERNS) {
    const score = scoreText(userText, pattern);
    if (score > 0) {
      scores.push({ mode: pattern.mode, score });
    }
  }

  if (scores.length === 0) {
    return {
      mode: 'edit',
      confidence: 0.3,
      secondaryIntents: [],
      reason: 'No strong signals found; defaulting to edit mode.',
      userOverride: false,
    };
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const secondaryIntents = scores.slice(1).map(s => s.mode);

  // Confidence is normalised: top score over sum of all scores (capped at 0.95)
  const totalScore = scores.reduce((acc, s) => acc + s.score, 0);
  const confidence = Math.min(0.95, top.score / totalScore);

  return {
    mode: top.mode,
    confidence,
    secondaryIntents,
    reason: `Matched patterns for '${top.mode}' (score ${top.score.toFixed(1)}).`,
    userOverride: false,
  };
}

/**
 * Build a `ModeDecision` representing an explicit user selection.
 * Called by the status bar mode picker when the user chooses a mode.
 */
export function buildUserModeDecision(mode: AssistantMode): ModeDecision {
  return {
    mode,
    confidence: 1.0,
    secondaryIntents: [],
    reason: 'Explicitly selected by user.',
    userOverride: true,
  };
}

/** All valid mode values, for use in UI dropdowns and validation. */
export const ALL_MODES: AssistantMode[] = [
  'plan', 'edit', 'debug', 'review', 'explain', 'search', 'test-fix', 'ask', 'code',
];

/** Human-readable labels for mode display in the status bar. */
export const MODE_LABELS: Record<AssistantMode, string> = {
  plan:       '📋 Plan',
  edit:       '✏️ Edit',
  debug:      '🐛 Debug',
  review:     '🔍 Review',
  explain:    '💡 Explain',
  search:     '🔎 Search',
  'test-fix': '🧪 Test-Fix',
  ask:        '💬 Ask',
  code:       '⌨️ Code',
};

// ─── LLM-based classifier ─────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a request intent classifier for a coding assistant.
Given a user message, respond with exactly ONE token — the intent label that best fits.
Valid labels: plan edit debug review explain search test-fix ask code
No explanation, no punctuation, no extra words — just the label.`;

/**
 * Classify the user message using a secondary LLM provider.
 * Falls back to the regex classifier if the provider call fails or returns
 * an unrecognised token.
 */
export async function classifyModeWithLLM(
  userText: string,
  provider: ILLMProvider,
): Promise<ModeDecision> {
  try {
    let response = '';
    const stream = provider.stream(
      [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        { role: 'user', content: userText.slice(0, 500) }, // cap to keep call cheap
      ],
      [],
      8, // only need one token
    );
    for await (const event of stream) {
      if (event.type === 'text') { response += event.delta; }
      if (event.type === 'done') { break; }
    }
    const token = response.trim().toLowerCase() as AssistantMode;
    if ((ALL_MODES as string[]).includes(token)) {
      return {
        mode: token,
        confidence: 0.9,
        secondaryIntents: [],
        reason: `LLM classifier returned '${token}'.`,
        userOverride: false,
      };
    }
  } catch {
    // fall through to regex fallback
  }
  return classifyMode(userText);
}
