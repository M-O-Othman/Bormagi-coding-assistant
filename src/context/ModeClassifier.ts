// ─── Mode Classifier ──────────────────────────────────────────────────────────
//
// Three-mode classifier: ask | plan | code
//
//   ask  — questions and explanations only; no file writes.
//   plan — the user wants a plan/design document written for review before
//          any implementation begins.
//   code — everything else: implement, fix, debug, refactor, test, etc.
//          For complex tasks the agent plans internally then executes;
//          for simple tasks it writes immediately.
//
// The user selects mode explicitly via the status bar dropdown.
// This classifier is the auto-detect fallback when no explicit selection exists.

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
    mode: 'ask',
    strong: [
      /\b(what\s+is|what\s+are|what\s+does|how\s+does|how\s+do\s+I|explain|describe|tell\s+me|why\s+is|why\s+does|clarify|understand|overview|summary\s+of|walk\s+me\s+through)\b/i,
    ],
    weak: [
      /\b(question|curious|wondering|help\s+me\s+understand|can\s+you\s+explain)\b/i,
    ],
  },
  {
    mode: 'plan',
    strong: [
      /\b(plan|design|architect|architecture|how\s+should\s+(I|we|the)|what\s+(files|approach|strategy)\s+(should|would|do\s+I)|diagram|sketch|outline|proposal|before\s+(I|we)\s+(implement|write|code))\b/i,
    ],
    weak: [
      /\b(think\s+about|consider|structure|organise|organize|approach|design\s+for)\b/i,
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
      mode: 'code',
      confidence: 0.7,
      secondaryIntents: [],
      reason: 'No ask/plan signals found; defaulting to code mode.',
      userOverride: false,
    };
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const secondaryIntents = scores.slice(1).map(s => s.mode);

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
export const ALL_MODES: AssistantMode[] = ['ask', 'plan', 'code'];

/** Human-readable labels for mode display in the status bar. */
export const MODE_LABELS: Record<AssistantMode, string> = {
  ask:  '💬 Ask',
  plan: '📋 Plan',
  code: '⌨️ Code',
};

// ─── LLM-based classifier ─────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a request intent classifier for a coding assistant.
Given a user message, respond with exactly ONE token — the intent label that best fits.
Valid labels: ask plan code
  ask  = questions, explanations, no file changes wanted
  plan = user wants a design/plan document before implementation
  code = implement, fix, edit, debug, refactor, build, create, or modify anything
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
