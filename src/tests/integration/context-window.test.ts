// ─── Integration tests for context window management (NF2-QA-001 / NF2-AI-001) ─
//
// Tests token estimation and trim logic introduced in AgentRunner.
// The logic is inlined here as pure functions to avoid instantiating AgentRunner
// (which depends on VS Code APIs). Same pattern used in contract.test.ts.
//
// Run with: npx jest src/tests/integration/context-window.test.ts

import type { ChatMessage } from '../../types';
import { __setTestData, getAppData } from '../../data/DataStore';

// Inject the context limits needed by these tests before any test runs.
beforeAll(() => {
  __setTestData({
    contextLimits: {
      'gpt-4o':                    128_000,
      'claude-sonnet-4-6':         200_000,
      'deepseek-chat':              65_536,
    },
    contextWindow: { trimThreshold: 0.9, keepTurns: 10 },
    secretPatterns:    [],
    injectionPatterns: [],
  });
});

function estimateTokenCount(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type: string; text?: string }>) {
        if (block.type === 'text' && block.text) {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

const TRIM_THRESHOLD = 0.9;  // 90% of limit
const KEEP_TURNS = 10;

function shouldTrim(messages: ChatMessage[], modelName: string): boolean {
  const limit = getAppData().contextLimits[modelName] ?? 0;
  if (limit === 0) { return false; }
  return estimateTokenCount(messages) >= limit * TRIM_THRESHOLD;
}

function trimMessages(messages: ChatMessage[]): { trimmed: ChatMessage[]; removedCount: number } {
  const systemMsgs  = messages.filter(m => m.role === 'system');
  const nonSystem   = messages.filter(m => m.role !== 'system');
  const kept        = nonSystem.length > KEEP_TURNS ? nonSystem.slice(nonSystem.length - KEEP_TURNS) : nonSystem;
  return {
    trimmed: [...systemMsgs, ...kept],
    removedCount: nonSystem.length - kept.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count: number, charsEach: number, role: 'user' | 'assistant' = 'user'): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role,
    content: 'x'.repeat(charsEach) + ` turn-${i}`,
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Context window — token estimation', () => {

  test('empty message list → 0 tokens', () => {
    expect(estimateTokenCount([])).toBe(0);
  });

  test('string content: 4 chars = 1 token', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'abcd' }];
    expect(estimateTokenCount(msgs)).toBe(1);
  });

  test('multiple messages are summed correctly', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },   // 28 chars → 7 tokens
      { role: 'user', content: 'Hello there!' },                     // 12 chars → 3 tokens
    ];
    const tokens = estimateTokenCount(msgs);
    expect(tokens).toBe(Math.ceil(40 / 4)); // 10
  });

  test('partial char count rounds up', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'abc' }]; // 3 chars → ceil(3/4) = 1
    expect(estimateTokenCount(msgs)).toBe(1);
  });

  test('known model is in the limits map', () => {
    const limits = getAppData().contextLimits;
    expect(limits['claude-sonnet-4-6']).toBe(200_000);
    expect(limits['gpt-4o']).toBe(128_000);
    expect(limits['deepseek-chat']).toBe(65_536);
  });

  test('unknown model returns 0 (no limit enforced)', () => {
    expect(getAppData().contextLimits['totally-unknown-model'] ?? 0).toBe(0);
  });
});

describe('Context window — shouldTrim', () => {

  test('returns false when model is unknown', () => {
    const msgs = makeMessages(100, 1_000);
    expect(shouldTrim(msgs, 'unknown-model')).toBe(false);
  });

  test('returns false well below threshold', () => {
    // 10 messages × 100 chars = 1000 chars → ~250 tokens. limit 65536. far below 90%.
    const msgs = makeMessages(10, 100);
    expect(shouldTrim(msgs, 'deepseek-chat')).toBe(false);
  });

  test('returns true when at 90% of context limit', () => {
    // deepseek-chat limit = 65536. 90% = 58982 tokens = ~235928 chars.
    // 60 messages × 4000 chars = 240000 chars → 60000 tokens → 91.5% → should trim
    const msgs = makeMessages(60, 4_000);
    expect(shouldTrim(msgs, 'deepseek-chat')).toBe(true);
  });

  test('returns false exactly at 89% of limit', () => {
    // deepseek-chat: 65536 * 0.89 = 58327 tokens → 233308 chars
    // 57 messages × 4000 chars = 228000 chars → 57000 tokens = 87% → below threshold
    const msgs = makeMessages(57, 4_000);
    expect(shouldTrim(msgs, 'deepseek-chat')).toBe(false);
  });
});

describe('Context window — trimMessages', () => {

  test('keeps all turns when count is at or below KEEP_TURNS', () => {
    const msgs = makeMessages(10, 100);
    const { trimmed, removedCount } = trimMessages(msgs);
    expect(trimmed).toHaveLength(10);
    expect(removedCount).toBe(0);
  });

  test('trims to last KEEP_TURNS non-system messages', () => {
    const msgs = makeMessages(25, 100);
    const { trimmed, removedCount } = trimMessages(msgs);
    expect(trimmed).toHaveLength(KEEP_TURNS);
    expect(removedCount).toBe(15);
  });

  test('preserves system messages and appends them before non-system', () => {
    const systemMsg: ChatMessage = { role: 'system', content: 'You are a helpful assistant.' };
    const userMsgs = makeMessages(20, 100);
    const all = [systemMsg, ...userMsgs];

    const { trimmed, removedCount } = trimMessages(all);
    expect(trimmed[0].role).toBe('system');
    expect(trimmed[0].content).toBe(systemMsg.content);
    expect(trimmed).toHaveLength(1 + KEEP_TURNS); // 1 system + 10 user
    expect(removedCount).toBe(10);
  });

  test('multiple system messages are all preserved', () => {
    const sys1: ChatMessage = { role: 'system', content: 'Prompt A.' };
    const sys2: ChatMessage = { role: 'system', content: 'Prompt B.' };
    const userMsgs = makeMessages(15, 100);
    const all = [sys1, sys2, ...userMsgs];

    const { trimmed } = trimMessages(all);
    expect(trimmed.filter(m => m.role === 'system')).toHaveLength(2);
    expect(trimmed.filter(m => m.role !== 'system')).toHaveLength(KEEP_TURNS);
  });

  test('trimmed messages are the MOST RECENT turns', () => {
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
    }));

    const { trimmed } = trimMessages(msgs);
    // Last 10 are messages 10–19
    expect(trimmed[0].content).toBe('Message 10');
    expect(trimmed[9].content).toBe('Message 19');
  });

  test('exactly KEEP_TURNS messages → no trimming occurs', () => {
    const msgs = makeMessages(KEEP_TURNS, 200);
    const { trimmed, removedCount } = trimMessages(msgs);
    expect(removedCount).toBe(0);
    expect(trimmed).toHaveLength(KEEP_TURNS);
  });

  test('empty message list → returns empty trimmed with 0 removed', () => {
    const { trimmed, removedCount } = trimMessages([]);
    expect(trimmed).toHaveLength(0);
    expect(removedCount).toBe(0);
  });
});
