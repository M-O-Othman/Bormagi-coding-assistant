import { ConfigManager } from '../config/ConfigManager';
import { ChatMessage } from '../types';
import { SessionMemory } from '../memory/SessionMemory';
import { PublishedKnowledge } from '../memory/PublishedKnowledge';

const MAX_HISTORY_MESSAGES = 20;
// Number of past Memory.md turns to inject as context on session start
const PERSISTENT_MEMORY_TURNS = 5;

/**
 * Manages per-agent conversation memory.
 * - In-memory session buffer: active chat messages for the current session.
 * - Persistent memory: last N turns loaded from Memory.md at session start, injected
 *   as a read-only context block so the agent retains long-term decisions.
 * - Disk: turns are appended to Memory.md via ConfigManager (append-only).
 */
export class MemoryManager {
  private sessionMessages = new Map<string, ChatMessage[]>();
  /** Track which agents have already had their persistent memory loaded this session. */
  private memoryLoaded = new Set<string>();

  readonly sessionMemory: SessionMemory;
  readonly publishedKnowledge: PublishedKnowledge;

  constructor(private readonly config: ConfigManager) {
    this.sessionMemory = new SessionMemory(config.rootDir);
    this.publishedKnowledge = new PublishedKnowledge(config.rootDir);
  }

  /**
   * Returns session history for agentId, loading persisted memory on first call.
   * Persistent memory is prepended as a single system message so the agent has
   * access to long-term decisions without it counting as live conversation turns.
   */
  async getSessionHistoryWithMemory(agentId: string): Promise<ChatMessage[]> {
    if (!this.memoryLoaded.has(agentId)) {
      this.memoryLoaded.add(agentId);
      const persisted = await this.config.readLastMemoryTurns(agentId, PERSISTENT_MEMORY_TURNS);
      if (persisted) {
        if (!this.sessionMessages.has(agentId)) {
          this.sessionMessages.set(agentId, []);
        }
        // Inject as a system context message at the start of the session
        this.sessionMessages.get(agentId)!.unshift({
          role: 'system',
          content: `[Long-term memory — last ${PERSISTENT_MEMORY_TURNS} conversation summaries]\n${persisted}`
        });
      }
    }
    return this.sessionMessages.get(agentId) ?? [];
  }

  /** Synchronous accessor used for cases where async is not available. */
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
    this.memoryLoaded.delete(agentId);
    this.sessionMemory.clearSession(agentId);
  }

  resetPublishedKnowledge(agentId: string): void {
    this.publishedKnowledge.resetAll(agentId);
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
