import type { ChatMessage } from '../../types';

/**
 * Strips all known control-plane markers from a message transcript before
 * it is persisted to memory or sent to a provider.
 *
 * Patterns removed:
 *   - [write_file: path (N chars)] / [edit_file: ...] style labels
 *   - \x00TOOL:name:{json}\x00  null-byte sentinels
 *   - <tool_result ...>...</tool_result>  XML blocks
 *   - [SYSTEM ERROR] prefix lines
 *   - [Batch: N/M done. ...] progress lines
 *   - [Milestone] lines
 *   - [Discovery Budget] advisory lines
 *   - [BLOCKED] / [BUDGET EXHAUSTED] / [BATCH VIOLATION] runtime rejection lines
 *
 * Called before memoryManager.addMessage() / memoryManager.persistTurn() and
 * in prepareMessagesForProvider() as defence-in-depth.
 */
export function sanitiseTranscript(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    const cleaned = sanitiseContent(msg.content);
    if (cleaned === msg.content) { return msg; }
    return { ...msg, content: cleaned };
  });
}

/** Sanitise a single string of content. */
export function sanitiseContent(text: string): string {
  return text
    // [write_file: path (N chars)] / [edit_file: ...] style labels
    .replace(/\[(?:write_file|edit_file|read_file|list_files|run_command)[^\]]*\]/g, '')
    // Null-byte tool sentinels: \x00TOOL:name:{...}\x00
    .replace(/\x00TOOL:[^\x00]*\x00/g, '')
    // <tool_result ...>...</tool_result> XML blocks
    .replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '')
    // [SYSTEM ERROR] prefix lines
    .replace(/\[SYSTEM ERROR\][^\n]*/g, '')
    // [Batch: N/M done. ...] progress lines
    .replace(/\[Batch(?:: [^\]]+)?\]/g, '')
    // [Milestone] lines
    .replace(/\[Milestone\][^\n]*/g, '')
    // [Discovery Budget] advisory lines
    .replace(/\[Discovery Budget\][^\n]*/g, '')
    // [BLOCKED] runtime rejection lines
    .replace(/\[BLOCKED\][^\n]*/g, '')
    // [BUDGET EXHAUSTED] lines
    .replace(/\[BUDGET EXHAUSTED\][^\n]*/g, '')
    // [BATCH VIOLATION] lines
    .replace(/\[BATCH VIOLATION\][^\n]*/g, '')
    // [Task state updated ...] internal lines
    .replace(/\[Task state updated[^\]]*\]/g, '')
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
