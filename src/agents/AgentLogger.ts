import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage } from '../types';

const LOGS_DIR = 'logs';
const MAX_CONTENT_CHARS = 4000; // truncate large payloads in the log

/**
 * Human-readable per-agent log writer.
 *
 * One log file per agent: .bormagi/logs/{agentId}.log
 *
 * VS Code settings:
 *   bormagi.logging.enabled          (boolean, default true)
 *   bormagi.logging.clearOnSession   (boolean, default false)
 *   bormagi.logging.maxContentChars  (number,  default 4000)
 */
export class AgentLogger {
  private readonly logPath: string;
  private readonly maxChars: number;
  private readonly enabled: boolean;

  constructor(
    private readonly workspaceRoot: string,
    private readonly agentId: string
  ) {
    const cfg = vscode.workspace.getConfiguration('bormagi');
    this.enabled = cfg.get<boolean>('logging.enabled', true);
    this.maxChars = cfg.get<number>('logging.maxContentChars', MAX_CONTENT_CHARS);

    const logsDir = path.join(workspaceRoot, '.bormagi', LOGS_DIR);
    this.logPath = path.join(logsDir, `${agentId}.log`);
  }

  /** Call once at the start of every runner.run() invocation. */
  sessionStart(mode: string): void {
    if (!this.enabled) { return; }
    const cfg = vscode.workspace.getConfiguration('bormagi');
    const clearOnSession = cfg.get<boolean>('logging.clearOnSession', false);

    const logsDir = path.dirname(this.logPath);
    fs.mkdirSync(logsDir, { recursive: true });

    if (clearOnSession && fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, '', 'utf8');
    }

    this.writeLine(
      '\n' + '═'.repeat(80) +
      `\nSESSION START  agent=${this.agentId}  mode=${mode}  ${new Date().toISOString()}` +
      '\n' + '═'.repeat(80)
    );
  }

  logSystemPrompt(systemPrompt: string): void {
    if (!this.enabled) { return; }
    this.section('SYSTEM PROMPT', this.truncate(systemPrompt));
  }

  /** Log the full messages array before an LLM API call. */
  logApiCall(callIndex: number, messages: ChatMessage[]): void {
    if (!this.enabled) { return; }
    const formatted = messages.map(m => {
      const tag = `[${m.role.toUpperCase()}]`;
      return `${tag} ${this.truncate(m.content, 800)}`;
    }).join('\n');
    this.section(`MESSAGES → LLM  (call #${callIndex})`, formatted);
  }

  logToolCall(name: string, input: Record<string, unknown>): void {
    if (!this.enabled) { return; }
    // Truncate large content fields (write_file payloads, etc.)
    const sanitised = { ...input };
    for (const key of ['content', 'content_markdown', 'slides_markdown']) {
      if (typeof sanitised[key] === 'string') {
        const val = sanitised[key] as string;
        sanitised[key] = val.length > this.maxChars
          ? `${val.slice(0, this.maxChars)}… [${val.length} chars total]`
          : val;
      }
    }
    this.section(`TOOL CALL: ${name}`, JSON.stringify(sanitised, null, 2));
  }

  logToolResult(name: string, result: string): void {
    if (!this.enabled) { return; }
    this.section(`TOOL RESULT: ${name}`, this.truncate(result));
  }

  logModelText(text: string): void {
    if (!this.enabled) { return; }
    // Batch text output — don't write per-delta; caller should call this once per turn.
    this.section('MODEL TEXT', this.truncate(text));
  }

  logTokenUsage(callIndex: number, input: number, output: number, cacheRead = 0, cacheCreate = 0): void {
    if (!this.enabled) { return; }
    const detail = [
      `call #${callIndex}`,
      `in=${input}`,
      `out=${output}`,
      cacheRead > 0 ? `cache_read=${cacheRead}` : null,
      cacheCreate > 0 ? `cache_create=${cacheCreate}` : null,
    ].filter(Boolean).join('  |  ');
    this.section('TOKEN USAGE', detail);
  }

  logAssistantTurn(turnText: string): void {
    if (!this.enabled) { return; }
    this.section('ASSISTANT TURN (stored to history)', this.truncate(turnText));
  }

  logError(context: string, error: unknown): void {
    if (!this.enabled) { return; }
    this.section(`ERROR in ${context}`, String(error));
  }

  sessionEnd(toolsUsed: string[]): void {
    if (!this.enabled) { return; }
    this.writeLine(
      `\n── SESSION END  tools=[${toolsUsed.join(', ')}]  ${new Date().toISOString()} ──\n`
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private section(title: string, body: string): void {
    this.writeLine(`\n┌─ ${title}\n${body}\n└─`);
  }

  private truncate(text: string, limit = this.maxChars): string {
    if (text.length <= limit) { return text; }
    return `${text.slice(0, limit)}\n… [truncated — ${text.length} chars total]`;
  }

  private writeLine(line: string): void {
    try {
      fs.appendFileSync(this.logPath, line + '\n', 'utf8');
    } catch {
      // Silently swallow — log failures must never crash the agent
    }
  }
}
