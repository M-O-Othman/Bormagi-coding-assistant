import type { ChatMessage } from '../../types';
import { getAppData } from '../../data/DataStore';

/** Character-based token estimate: ~4 chars/token. Conservative for code/prose. */
export function estimateTokenCount(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

/**
 * Scan message content for known secret patterns (loaded from data/security.json).
 * Returns the matching regexes so the caller can decide how to surface a warning.
 */
export function scanForSecrets(messages: ChatMessage[]): RegExp[] {
  const { secretPatterns } = getAppData();
  const blob = messages.map(m => m.content).join('\n');
  return secretPatterns.filter(p => p.test(blob));
}

export interface TrimResult {
  didTrim: boolean;
  removedCount: number;
  estimatedTokens: number;
  contextLimit: number;
}

/**
 * Trim oldest non-system turns when estimated tokens exceed the configured threshold
 * of the model's context limit (thresholds loaded from data/security.json).
 * Mutates the messages array in-place for efficiency.
 * Returns trim metadata so the caller can surface a warning thought event.
 */
export function trimToContextLimit(messages: ChatMessage[], modelName: string): TrimResult {
  const { contextLimits, contextWindow } = getAppData();
  const { trimThreshold, keepTurns } = contextWindow;

  const contextLimit = contextLimits[modelName] ?? 0;
  if (contextLimit === 0) {
    return { didTrim: false, removedCount: 0, estimatedTokens: 0, contextLimit: 0 };
  }

  const estimated = estimateTokenCount(messages);
  if (estimated < contextLimit * trimThreshold) {
    return { didTrim: false, removedCount: 0, estimatedTokens: estimated, contextLimit };
  }

  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem  = messages.filter(m => m.role !== 'system');
  const trimmed    = nonSystem.length > keepTurns
    ? nonSystem.slice(nonSystem.length - keepTurns)
    : nonSystem;
  const removedCount = nonSystem.length - trimmed.length;

  messages.length = 0;
  messages.push(...systemMsgs, ...trimmed);

  return { didTrim: true, removedCount, estimatedTokens: estimated, contextLimit };
}
