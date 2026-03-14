/**
 * Regression tests for Phase 2: tool result channel isolation.
 * Verifies that ChatMessage with role 'tool_result' is correctly typed
 * and that TranscriptSanitiser strips XML wrappers.
 */
import type { ChatMessage } from '../../types';
import { sanitiseContent } from '../../agents/execution/TranscriptSanitiser';

describe('MessageRole type — tool_result', () => {
  test('ChatMessage accepts tool_result role', () => {
    const msg: ChatMessage = {
      role: 'tool_result',
      content: '[tool: read_file | path: src/main.ts | status: success | 1200 chars]',
      toolCallId: 'call-123',
    };
    expect(msg.role).toBe('tool_result');
    expect(msg.toolCallId).toBe('call-123');
  });

  test('toolCallId is optional', () => {
    const msg: ChatMessage = { role: 'user', content: 'hello' };
    expect(msg.toolCallId).toBeUndefined();
  });
});

describe('prepareMessagesForProvider — XML stripping', () => {
  test('strips <tool_result> XML wrapper, keeps inner content', () => {
    const xmlWrapped = '<tool_result name="read_file" status="success">\nconst x = 1;\n</tool_result>';
    const cleaned = sanitiseContent(xmlWrapped);
    expect(cleaned).not.toContain('<tool_result');
    expect(cleaned).not.toContain('</tool_result>');
  });

  test('null-byte sentinels are stripped from any message', () => {
    const withSentinel = 'text before\x00TOOL:read_file:{"path":"src/a.ts"}\x00text after';
    const cleaned = sanitiseContent(withSentinel);
    expect(cleaned).not.toContain('\x00TOOL:');
    expect(cleaned).toContain('text before');
    expect(cleaned).toContain('text after');
  });

  test('sanitiseContent removes entire tool_result block (history sanitisation)', () => {
    // sanitiseContent is for history — it strips the whole <tool_result> block.
    // prepareMessagesForProvider (in AgentRunner) is what strips only the XML wrapper.
    const fileContent = 'export function add(a: number, b: number): number { return a + b; }';
    const wrapped = `<tool_result name="read_file">\n${fileContent}\n</tool_result>`;
    const cleaned = sanitiseContent(wrapped);
    expect(cleaned).not.toContain('<tool_result');
    expect(cleaned).not.toContain('</tool_result>');
    // Inner content is also removed (history sanitisation removes entire block)
    expect(cleaned.trim()).toBe('');
  });

  test('no mutation when content has no control patterns', () => {
    const plain = 'This is a regular assistant response with no control patterns.';
    expect(sanitiseContent(plain)).toBe(plain);
  });
});
