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

  /**
   * Strip noise from agent response text before writing to persistent memory.
   * Removes:
   *   - DeepSeek / Gemini thinking-token wrappers that leak through as plain text.
   *   - Alternate <think>…</think> format used by some models.
   *   - Pure narration lines ("Let me read…", "Now I'll…") that add no factual value.
   */
  private sanitizeForPersistence(text: string): string {
    return text
      // DeepSeek / Gemini internal thinking sentinels
      .replace(/<｜(?:begin|end)▁of▁thinking｜>/g, '')
      // <think>…</think> style used by some models
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // Leading narration-only lines carrying no factual content
      .replace(
        /^(let me|now (i('ll)?|let me)|i('ll| will) now)\s+(read|check|list|examine|look at|search|write|run|create)\b[^\n]*/gim,
        ''
      )
      // Collapse runs of 3+ blank lines left by the removals above
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

    const sanitized = this.sanitizeForPersistence(agentResponse);

    const entry =
      `### ${dateStr} — ${agentId}\n` +
      `**User:** ${userMessage}\n\n` +
      `**Agent:** ${sanitized}` +
      toolLine +
      `\n\n---`;

    await this.config.appendMemory(agentId, entry);
  }
}
