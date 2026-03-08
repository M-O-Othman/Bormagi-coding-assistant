// ─── Model / Provider Profiles ────────────────────────────────────────────────
//
// Per-model context limits, caching support, and compaction thresholds.
// Spec reference: §FR-12.
//
// Adding a new model: append an entry to MODEL_PROFILES and ensure
// getActiveModelProfile() can match it.

import type { ModelProfile, ContextThresholds } from '../context/types';
import type { ProviderConfig } from '../types';

// ─── Shared threshold sets ────────────────────────────────────────────────────

const STANDARD_THRESHOLDS: ContextThresholds = {
  warnAtPct:      0.65,
  pruneAtPct:     0.75,
  compactAtPct:   0.82,
  emergencyAtPct: 0.90,
};

// ─── Profile registry ─────────────────────────────────────────────────────────

export const MODEL_PROFILES: ModelProfile[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    provider:                   'anthropic',
    model:                      'claude-sonnet-4-6',
    maxContextTokens:           200_000,
    recommendedInputBudget:     180_000,
    defaultMaxOutputTokens:     8_000,
    supportsPromptCaching:      true,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 400,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  {
    provider:                   'anthropic',
    model:                      'claude-opus-4-6',
    maxContextTokens:           200_000,
    recommendedInputBudget:     180_000,
    defaultMaxOutputTokens:     8_000,
    supportsPromptCaching:      true,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 400,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  {
    provider:                   'anthropic',
    model:                      'claude-haiku-4-5-20251001',
    maxContextTokens:           200_000,
    recommendedInputBudget:     180_000,
    defaultMaxOutputTokens:     4_096,
    supportsPromptCaching:      true,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 300,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    provider:                   'openai',
    model:                      'gpt-4o',
    maxContextTokens:           128_000,
    recommendedInputBudget:     110_000,
    defaultMaxOutputTokens:     4_096,
    supportsPromptCaching:      false,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 350,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  {
    provider:                   'openai',
    model:                      'gpt-4o-mini',
    maxContextTokens:           128_000,
    recommendedInputBudget:     110_000,
    defaultMaxOutputTokens:     4_096,
    supportsPromptCaching:      false,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 300,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  // ── Google Gemini ──────────────────────────────────────────────────────────
  {
    provider:                   'gemini',
    model:                      'gemini-1.5-pro',
    maxContextTokens:           1_000_000,
    recommendedInputBudget:     800_000,
    defaultMaxOutputTokens:     8_192,
    supportsPromptCaching:      false,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 400,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  {
    provider:                   'gemini',
    model:                      'gemini-1.5-flash',
    maxContextTokens:           1_000_000,
    recommendedInputBudget:     800_000,
    defaultMaxOutputTokens:     8_192,
    supportsPromptCaching:      false,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 300,
    thresholds:                 STANDARD_THRESHOLDS,
  },
  // ── DeepSeek ───────────────────────────────────────────────────────────────
  {
    provider:                   'deepseek',
    model:                      'deepseek-chat',
    maxContextTokens:           65_536,
    recommendedInputBudget:     56_000,
    defaultMaxOutputTokens:     4_096,
    supportsPromptCaching:      false,
    supportsToolUse:            true,
    estimatedToolOverheadTokens: 300,
    thresholds:                 STANDARD_THRESHOLDS,
  },
];

// ─── Fallback profile ─────────────────────────────────────────────────────────

const FALLBACK_PROFILE: ModelProfile = {
  provider:                   'unknown',
  model:                      'unknown',
  maxContextTokens:           32_000,
  recommendedInputBudget:     28_000,
  defaultMaxOutputTokens:     2_048,
  supportsPromptCaching:      false,
  supportsToolUse:            true,
  estimatedToolOverheadTokens: 400,
  thresholds:                 STANDARD_THRESHOLDS,
};

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Returns the best-matching `ModelProfile` for the given provider config.
 * Falls back to a conservative generic profile if no exact match is found.
 */
export function getActiveModelProfile(providerCfg: ProviderConfig): ModelProfile {
  const providerKey = providerCfg.type === 'deepseek' || providerCfg.type === 'qwen' || providerCfg.type === 'openai_compatible'
    ? 'openai'
    : providerCfg.type;

  const match = MODEL_PROFILES.find(
    p => p.provider === providerKey && p.model === providerCfg.model
  );

  if (match) { return match; }

  // Partial match: same provider, any model
  const providerMatch = MODEL_PROFILES.find(p => p.provider === providerKey);
  return providerMatch ?? FALLBACK_PROFILE;
}

/** Returns the profile by exact provider + model string, or undefined. */
export function findProfile(provider: string, model: string): ModelProfile | undefined {
  return MODEL_PROFILES.find(p => p.provider === provider && p.model === model);
}
