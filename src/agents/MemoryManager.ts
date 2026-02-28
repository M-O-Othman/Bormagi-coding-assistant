import { ConfigManager } from '../config/ConfigManager';
import { ChatMessage } from '../types';

const MAX_HISTORY_MESSAGES = 20;

/**
 * Manages per-agent conversation memory.
 * Persists to Memory.md (append-only) and keeps an in-memory session buffer.
 */
export class MemoryManager {
  private sessionMessages = new Map<string, ChatMessage[]>();

  constructor(private readonly config: ConfigManager) {}

  getSessionHistory(agentId: string): ChatMessage[] {
    return this.sessionMessages.get(agentId) ?? [];
  }

  addMessage(agentId: string, message: ChatMessage): void {
    if (!this.sessionMessages.has(agentId)) {
      this.sessionMessages.set(agentId, []);
    }
    const history = this.sessionMessages.get(agentId)!;
    history.push(message);

    // Keep last N messages to avoid context overflow
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
  }

  clearSession(agentId: string): void {
    this.sessionMessages.delete(agentId);
  }

  async persistTurn(
    agentId: string,
    userMessage: string,
    agentResponse: string,
    toolsUsed: string[]
  ): Promise<void> {
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').split('.')[0];
    const toolLine = toolsUsed.length > 0 ? `\n**Tools Used:** ${toolsUsed.join(', ')}` : '';

    const entry =
      `### ${dateStr} — ${agentId}\n` +
      `**User:** ${userMessage}\n\n` +
      `**Agent:** ${agentResponse}` +
      toolLine +
      `\n\n---`;

    await this.config.appendMemory(agentId, entry);
  }
}
