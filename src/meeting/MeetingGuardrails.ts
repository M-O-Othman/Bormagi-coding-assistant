import * as fs from 'fs';
import * as path from 'path';

export interface MeetingGuardrailsConfig {
  decisionLock: {
    enabled: boolean;
    allowedTagsAfterFinalDecision: string[];
    recommendationMarkers: string[];
  };
  skip: {
    enforceExclusive: boolean;
    forbiddenSubTags: string[];
  };
  topicGuard: {
    minKeywordLength: number;
    offTopicMargin: number;
    minOtherHits: number;
    defaultAllowedDimensions: string[];
    dimensionKeywords: Record<string, string[]>;
  };
  humanIntent: {
    deferPatterns: string[];
    finalDecisionPatterns: string[];
    optionExtractPatterns: string[];
  };
  actionItems: {
    dedupe: boolean;
    ignorePatterns: string[];
  };
  summary: {
    nullLikePatterns: string[];
  };
  minutes: {
    dedupeExactRoundResponses: boolean;
  };
  responseValidation: {
    forbiddenPatterns: string[];
  };
}

const DEFAULT_GUARDRAILS: MeetingGuardrailsConfig = {
  decisionLock: {
    enabled: true,
    allowedTagsAfterFinalDecision: ['ACTION', 'VALIDATION', 'SKIP'],
    recommendationMarkers: [
      'Options:',
      'Recommended option',
      'What the human must decide',
      'DecisionPromptForHuman',
      'Tradeoffs'
    ]
  },
  skip: {
    enforceExclusive: true,
    forbiddenSubTags: [
      'RECOMMENDATION',
      'RISK',
      'OPEN_QUESTION',
      'ACTION',
      'VALIDATION',
      'CLARIFICATION_FOR_HUMAN'
    ]
  },
  topicGuard: {
    minKeywordLength: 5,
    offTopicMargin: 2,
    minOtherHits: 2,
    defaultAllowedDimensions: ['content', 'process', 'automation', 'quality'],
    dimensionKeywords: {
      content: [
        'requirement',
        'feature',
        'interface',
        'module',
        'component',
        'service',
        'api',
        'schema',
        'architecture',
        'design',
        'bug',
        'documentation',
        'specification'
      ],
      process: [
        'workflow',
        'process',
        'step',
        'owner',
        'responsibility',
        'plan',
        'timeline',
        'milestone',
        'dependency',
        'approval',
        'review',
        'acceptance',
        'handoff',
        'blocker'
      ],
      automation: [
        'automate',
        'automation',
        'script',
        'pipeline',
        'ci',
        'cd',
        'job',
        'runner',
        'playwright',
        'cypress',
        'integration',
        'scheduled'
      ],
      quality: [
        'quality',
        'accuracy',
        'consistency',
        'coverage',
        'validation',
        'verification',
        'regression',
        'testability',
        'reliability',
        'performance',
        'security',
        'usability'
      ]
    }
  },
  humanIntent: {
    deferPatterns: [
      '\\bnext agenda item\\b',
      '\\bproceed to next\\b',
      '^\\s*proceed\\s*[.!?]*\\s*$',
      '\\bmove on\\b',
      '\\bdefer(red)?\\b',
      '\\bpostpone\\b',
      '\\bskip this item\\b'
    ],
    finalDecisionPatterns: [
      '\\bthis is my decision\\b',
      '\\bi decide\\b',
      '\\bi (?:already )?decided\\b',
      '\\bis my decision\\b',
      '\\bdecision is\\b',
      '\\bmy decision is\\b',
      '\\bwe choose\\b',
      '\\boption\\s+[a-z0-9]+\\b',
      '\\bproceed with option\\s+[a-z0-9]+\\b',
      '\\bdo\\s+not\\s+suggest\\s+(?:these|those|the)?\\s*options?\\s+anymore\\b',
      '\\bdecision\\s+is\\s+final\\b'
    ],
    optionExtractPatterns: [
      '\\boption\\s+([a-z0-9]+)\\b',
      '\\bchoose\\s+([a-z0-9]+)\\b'
    ]
  },
  actionItems: {
    dedupe: true,
    ignorePatterns: [
      '^\\s*none\\s*[.!?]*\\s*$',
      '^\\s*n/?a\\s*[.!?]*\\s*$',
      '^\\s*no action(?:s)?\\s*[.!?]*\\s*$',
      '^\\s*not applicable\\s*[.!?]*\\s*$',
      '^\\s*tbd\\s*[.!?]*\\s*$'
    ]
  },
  summary: {
    nullLikePatterns: [
      '^\\s*none\\s*[.!?]*\\s*$',
      '^\\s*n/?a\\s*[.!?]*\\s*$',
      '^\\s*not applicable\\s*[.!?]*\\s*$'
    ]
  },
  minutes: {
    dedupeExactRoundResponses: true
  },
  responseValidation: {
    forbiddenPatterns: [
      '\\{\\{[^}]+\\}\\}'
    ]
  }
};

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) { return null; }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mergeObjects<T extends Record<string, unknown>>(base: T, override: Record<string, unknown> | null): T {
  if (!override) { return base; }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = out[key];
    if (Array.isArray(value)) {
      out[key] = value.slice();
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      out[key] = mergeObjects(baseVal as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function loadMeetingGuardrails(workspaceRoot: string): MeetingGuardrailsConfig {
  const bundledPath = path.join(workspaceRoot, 'data', 'meeting-guardrails.json');
  const overridePath = path.join(workspaceRoot, '.bormagi', 'meeting-config', 'guardrails.json');

  const bundled = readJson(bundledPath);
  const override = readJson(overridePath);

  const merged = mergeObjects(DEFAULT_GUARDRAILS as unknown as Record<string, unknown>, bundled);
  return mergeObjects(merged, override) as unknown as MeetingGuardrailsConfig;
}
