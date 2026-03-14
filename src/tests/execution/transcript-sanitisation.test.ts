/**
 * Regression tests for Phase 5: transcript sanitisation.
 * Verifies that all known control-plane markers are stripped from message content.
 */
import { sanitiseContent, sanitiseTranscript } from '../../agents/execution/TranscriptSanitiser';
import type { ChatMessage } from '../../types';

describe('sanitiseContent', () => {
  test('strips [write_file: path] labels', () => {
    const input = 'I will now [write_file: src/main.ts (1200 chars)] to disk';
    expect(sanitiseContent(input)).not.toContain('[write_file:');
  });

  test('strips null-byte TOOL sentinels', () => {
    const input = 'calling tool\x00TOOL:read_file:{"path":"src/foo.ts"}\x00 now';
    expect(sanitiseContent(input)).not.toContain('\x00TOOL:');
  });

  test('strips <tool_result> XML blocks', () => {
    const input = '<tool_result name="read_file" status="success">\nfile content here\n</tool_result>';
    expect(sanitiseContent(input)).not.toContain('<tool_result');
    expect(sanitiseContent(input)).not.toContain('</tool_result>');
  });

  test('strips [SYSTEM ERROR] lines', () => {
    const input = '[SYSTEM ERROR] write_file REJECTED: "src/foo.ts" already written\ncontinued text';
    const result = sanitiseContent(input);
    expect(result).not.toContain('[SYSTEM ERROR]');
    expect(result).toContain('continued text');
  });

  test('strips [Batch: N/M done] progress lines', () => {
    const input = 'Writing files\n[Batch: 3/5 done. Remaining: d.ts, e.ts]\nDone.';
    const result = sanitiseContent(input);
    expect(result).not.toContain('[Batch:');
  });

  test('strips [BLOCKED] runtime rejection lines', () => {
    const input = '[BLOCKED] Agent access to .bormagi/ is not permitted.';
    expect(sanitiseContent(input)).not.toContain('[BLOCKED]');
  });

  test('strips [BUDGET EXHAUSTED] lines', () => {
    const input = '[BUDGET EXHAUSTED] Discovery limit reached for this run.';
    expect(sanitiseContent(input)).not.toContain('[BUDGET EXHAUSTED]');
  });

  test('strips [BATCH VIOLATION] lines', () => {
    const input = '[BATCH VIOLATION] Path not in declared batch.';
    expect(sanitiseContent(input)).not.toContain('[BATCH VIOLATION]');
  });

  test('preserves legitimate assistant text', () => {
    const text = 'I have written the main component with React hooks and TypeScript.';
    expect(sanitiseContent(text)).toBe(text);
  });
});

describe('sanitiseTranscript', () => {
  test('sanitises all messages in the array', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please write src/app.ts' },
      { role: 'assistant', content: '[write_file: src/app.ts (500 chars)]\nHere is the file.' },
      { role: 'user', content: '<tool_result name="write_file">\nFile written: src/app.ts\n</tool_result>' },
    ];
    const sanitised = sanitiseTranscript(messages);
    expect(sanitised[1].content).not.toContain('[write_file:');
    expect(sanitised[2].content).not.toContain('<tool_result');
  });

  test('does not mutate original messages', () => {
    const original: ChatMessage = { role: 'assistant', content: '[Batch: 1/3 done]' };
    const messages = [original];
    sanitiseTranscript(messages);
    expect(original.content).toBe('[Batch: 1/3 done]'); // unchanged
  });
});
