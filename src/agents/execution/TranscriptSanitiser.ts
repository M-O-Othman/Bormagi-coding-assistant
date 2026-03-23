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
    // [Batch: N/M done. ...] progress lines
    .replace(/\[Batch(?:: [^\]]+)?\]/g, '')
    // [Milestone] lines
    .replace(/\[Milestone\][^\n]*/g, '')
    // [Discovery Budget] advisory lines
    .replace(/\[Discovery Budget\][^\n]*/g, '')
    // [Task state updated ...] internal lines
    .replace(/\[Task state updated[^\]]*\]/g, '')
    // [Cached] lines
    .replace(/\[Cached\][^\n]*/g, '')
    // [LOOP DETECTED] lines
    .replace(/\[LOOP DETECTED\][^\n]*/g, '')
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip repetitive execution-narration filler from assistant text before
 * persisting to session history. Only applied in code mode (DD11).
 *
 * Removes patterns like:
 *   - "I'll start by reading..."
 *   - "Let me first read..."
 *   - "First, let me read..."
 *   - "I'll start implementation based on..."
 *
 * Does NOT remove milestone summaries, completion text, or blocker descriptions.
 */
export function sanitiseCodeModeNarration(text: string): string {
  return text
    .replace(/^(I'll start by reading[^\n]*|Let me first read[^\n]*|First, let me read[^\n]*|I'll start implementation based on[^\n]*|Let me read the[^\n]*|I need to first read[^\n]*|I will now read[^\n]*|Let me check[^\n]*|I can see from the log[^\n]*)$/gim, '')
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
