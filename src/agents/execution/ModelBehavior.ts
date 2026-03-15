/**
 * Model-specific behavior profiles.
 *
 * Different models comply with instructions at different levels.
 * Gemini ignores "do not re-read" instructions more than Claude.
 * These profiles let the framework adjust its enforcement strategy.
 */

export interface ModelBehavior {
  /** How reliably does this model follow "do not re-read" instructions? */
  instructionCompliance: 'high' | 'medium' | 'low';
  /** Does the model support tool_choice: "any"? */
  supportsForceToolCall: boolean;
  /** Does the API support prompt caching? */
  supportsPromptCache: boolean;
  /** Max reads before forcing write (lower for less compliant models). */
  maxDiscoveryReads: number;
  /** Should narration be suppressed in silent mode? */
  suppressNarration: boolean;
}

const PROFILES: Record<string, ModelBehavior> = {
  // Anthropic models
  'claude-sonnet-4-6': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'claude-opus-4-6': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'claude-haiku-4-5': {
    instructionCompliance: 'medium',
    supportsForceToolCall: true,
    supportsPromptCache: true,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },

  // Google models
  'gemini-2.5-pro': {
    instructionCompliance: 'medium',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },
  'gemini-2.5-flash': {
    instructionCompliance: 'low',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 1,
    suppressNarration: true,
  },

  // OpenAI models
  'gpt-4o': {
    instructionCompliance: 'high',
    supportsForceToolCall: true,
    supportsPromptCache: false,
    maxDiscoveryReads: 3,
    suppressNarration: false,
  },
  'gpt-4o-mini': {
    instructionCompliance: 'medium',
    supportsForceToolCall: true,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },

  // DeepSeek
  'deepseek-chat': {
    instructionCompliance: 'medium',
    supportsForceToolCall: false,
    supportsPromptCache: false,
    maxDiscoveryReads: 2,
    suppressNarration: true,
  },
};

/** Default profile for unknown models — conservative settings. */
const DEFAULT_PROFILE: ModelBehavior = {
  instructionCompliance: 'medium',
  supportsForceToolCall: false,
  supportsPromptCache: false,
  maxDiscoveryReads: 2,
  suppressNarration: true,
};

/**
 * Get the behavior profile for a model.
 * Falls back to a conservative default for unknown models.
 *
 * @param modelName  The model identifier (e.g., 'claude-sonnet-4-6').
 */
export function getModelBehavior(modelName: string): ModelBehavior {
  // Try exact match first
  if (PROFILES[modelName]) return PROFILES[modelName];

  // Try prefix match (e.g., "claude-sonnet-4-6-20250514" matches "claude-sonnet-4-6")
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (modelName.startsWith(key)) return profile;
  }

  // Try family match
  if (modelName.includes('claude')) {
    return PROFILES['claude-sonnet-4-6']; // default Claude behavior
  }
  if (modelName.includes('gemini')) {
    return PROFILES['gemini-2.5-pro']; // default Gemini behavior
  }
  if (modelName.includes('gpt')) {
    return PROFILES['gpt-4o']; // default OpenAI behavior
  }

  return DEFAULT_PROFILE;
}
