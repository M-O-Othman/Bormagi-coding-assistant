/**
 * Deduplicates repeated tool results in the message history.
 *
 * When the same file is read multiple times or the same error appears
 * repeatedly, the full content is replaced with a compact reference
 * to the first occurrence. This prevents the context window from being
 * dominated by duplicate content.
 *
 * Inspired by Cline's contextHistoryUpdates map.
 */

import type { ChatMessage } from '../../types';

export class ContextDeduplicator {
  private seen = new Map<string, { turnIndex: number; label: string }>();

  /**
   * Process messages and replace duplicate tool_result content with
   * compact references. Returns a new array — does not mutate input.
   */
  deduplicate(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg, idx) => {
      // Only deduplicate tool results
      if (msg.role !== 'tool_result') return msg;

      const hash = this.hashContent(msg.content);
      const existing = this.seen.get(hash);

      if (existing) {
        return {
          ...msg,
          content: `[Duplicate of turn #${existing.turnIndex}: ${existing.label}]`,
        };
      }

      // Extract a short label from the content
      const label = this.extractLabel(msg.content);
      this.seen.set(hash, { turnIndex: idx, label });
      return msg;
    });
  }

  /**
   * Reset for a new session.
   */
  reset(): void {
    this.seen.clear();
  }

  private hashContent(content: string): string {
    // Use first 500 chars for hash — enough to detect duplicates
    // without spending time hashing 15K-char file contents
    const sample = content.slice(0, 500);
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }

  private extractLabel(content: string): string {
    // Try to extract tool name and path from XML-formatted results
    const nameMatch = content.match(/name="([^"]+)"/);
    const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
    if (nameMatch && pathMatch) {
      return `${nameMatch[1]}:${pathMatch[1]}`;
    }
    if (nameMatch) {
      return nameMatch[1];
    }
    return content.slice(0, 60).replace(/\n/g, ' ');
  }
}
