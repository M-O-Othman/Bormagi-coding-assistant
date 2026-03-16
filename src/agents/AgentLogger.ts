import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage } from '../types';
import type { ExecutionStateData } from './ExecutionStateManager';

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
  private systemPromptReference = '[system prompt used]';

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

  logSystemPrompt(systemPrompt: string, promptSources: string[] = []): void {
    if (!this.enabled) { return; }
    const sourceLabel = promptSources.length > 0
      ? `[system prompt used from file(s): ${promptSources.join(', ')}]`
      : '[system prompt used from in-memory/default sources]';
    this.systemPromptReference = sourceLabel;
    this.section('SYSTEM PROMPT', `${sourceLabel}\n[length=${systemPrompt.length} chars]`);
  }

  /** Log the full messages array before an LLM API call. */
  logApiCall(callIndex: number, messages: ChatMessage[]): void {
    if (!this.enabled) { return; }
    const formatted = messages.map((m, idx) => {
      const tag = `[${m.role.toUpperCase()}]`;
      if (idx === 0 && m.role === 'system') {
        return `${tag} ${this.systemPromptReference}`;
      }
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

  /** Log a compact action breadcrumb for process tracing. */
  logAction(action: string, detail?: string): void {
    if (!this.enabled) { return; }
    this.writeLine(`── ACTION: ${action}${detail ? ` | ${this.truncate(detail, 200)}` : ''}`);
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

  // ─── FIX 8: Comprehensive structured logging ────────────────────────────────

  /** Log the exact messages array sent to the provider on each iteration. */
  logProviderRequest(iterationNumber: number, messages: ChatMessage[], mode: string): void {
    if (!this.enabled) { return; }
    const summary = messages.map((m, i) => {
      if (i === 0 && m.role === 'system') {
        return `  [${i}] role=system len=${m.content.length} "${this.systemPromptReference}"`;
      }
      const contentLen = m.content.length;
      const preview = m.content.slice(0, 200).replace(/\n/g, ' ');
      return `  [${i}] role=${m.role} len=${contentLen} "${preview}…"`;
    }).join('\n');
    this.section(`PROVIDER REQUEST (iteration #${iterationNumber}, mode=${mode})`,
      `Messages: ${messages.length}\n${summary}`);
  }

  /** Log execution state snapshot at each iteration. */
  logExecutionState(iterationNumber: number, state: ExecutionStateData): void {
    if (!this.enabled) { return; }
    const lines = [
      `  phase: ${state.executionPhase ?? 'INITIALISING'}`,
      `  runPhase: ${state.runPhase ?? 'RUNNING'}`,
      `  iterations: ${state.iterationsUsed}`,
      `  resolvedInputs: [${state.resolvedInputs.join(', ')}]`,
      `  artifactsCreated: [${state.artifactsCreated.join(', ')}]`,
      `  nextActions: [${state.nextActions.join(', ')}]`,
      `  nextToolCall: ${state.nextToolCall ? `${state.nextToolCall.tool}(${JSON.stringify(state.nextToolCall.input).slice(0, 100)})` : 'none'}`,
      `  blockedReadCount: ${state.blockedReadCount ?? 0}`,
      `  sameToolLoop: ${state.sameToolLoop ? `${state.sameToolLoop.tool}:${state.sameToolLoop.path ?? ''}x${state.sameToolLoop.count}` : 'none'}`,
      `  resolvedInputContents: [${Object.keys(state.resolvedInputContents ?? {}).join(', ')}]`,
    ];
    this.section(`EXECUTION STATE (iteration #${iterationNumber})`, lines.join('\n'));
  }

  /** Log phase transitions with reason. */
  logPhaseTransition(from: string, to: string, reason: string): void {
    if (!this.enabled) { return; }
    this.writeLine(`\n── PHASE: ${from} → ${to} (${reason})`);
  }

  /** Log context cost breakdown per iteration. */
  logContextCost(iterationNumber: number, breakdown: {
    systemPromptTokens: number; stateTokens: number; fileContentTokens: number;
    toolResultTokens: number; userMessageTokens: number; totalTokens: number;
  }): void {
    if (!this.enabled) { return; }
    const lines = [
      `  system: ${breakdown.systemPromptTokens}`,
      `  state: ${breakdown.stateTokens}`,
      `  files: ${breakdown.fileContentTokens}`,
      `  toolResults: ${breakdown.toolResultTokens}`,
      `  user: ${breakdown.userMessageTokens}`,
      `  TOTAL: ${breakdown.totalTokens}`,
    ];
    this.section(`CONTEXT COST (iteration #${iterationNumber})`, lines.join('\n'));
  }

  /** Log loop guard activation. */
  logGuardActivation(
    guardType: 'LOOP_DETECTED' | 'DISCOVERY_BUDGET' | 'WRITE_ONLY' | 'BATCH_ALREADY_ACTIVE',
    tool: string, toolPath: string | undefined, iterationNumber: number,
  ): void {
    if (!this.enabled) { return; }
    this.writeLine(`\n── GUARD: ${guardType} on ${tool}${toolPath ? `:${toolPath}` : ''} at iteration #${iterationNumber}`);
  }

  /** Log recovery trigger and outcome. */
  logRecovery(trigger: string, success: boolean, action: string): void {
    if (!this.enabled) { return; }
    this.writeLine(`\n── RECOVERY: trigger=${trigger} success=${success} action=${action}`);
  }

  /** Log deterministic dispatch (bypass of LLM call). */
  logDeterministicDispatch(tool: string, toolPath: string | undefined, reason: string): void {
    if (!this.enabled) { return; }
    this.writeLine(`\n── DETERMINISTIC DISPATCH: ${tool}${toolPath ? ` → ${toolPath}` : ''} (${reason})`);
  }

  // ─── Structured turn/session summaries (ACTION 15) ──────────────────────

  /**
   * Log a structured per-turn summary as a single JSON line.
   * Called at the end of each iteration in the while(continueLoop) loop.
   */
  logTurnSummary(entry: TurnSummary): void {
    if (!this.enabled) { return; }
    const line = `┌─ TURN_SUMMARY\n${JSON.stringify(entry, null, 2)}\n└─\n`;
    this.writeLine(line);
  }

  /**
   * Log a structured session summary as a single JSON line.
   * Called at session end.
   */
  logSessionSummary(summary: SessionSummary): void {
    if (!this.enabled) { return; }
    const line = `┌─ SESSION_SUMMARY\n${JSON.stringify(summary, null, 2)}\n└─\n`;
    this.writeLine(line);
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

export interface TurnSummary {
  turn: number;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  toolCalled?: string;
  toolPath?: string;
  toolStatus?: string;
  toolReasonCode?: string;
  writtenThisTurn: string[];
  cumulativeWrites: number;
  cumulativeReads: number;
  blockedReads: number;
  systemPromptTokens: number;
  contextPacketTokens: number;
  toolResultTokens: number;
  llmCallSkipped: boolean;
  deterministicDispatch: boolean;
}

export interface SessionSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  uniqueFilesWritten: string[];
  uniqueFilesRead: string[];
  loopDetections: number;
  discoveryBudgetExceeded: number;
  recoveryAttempts: number;
  llmCallsSkipped: number;
  deterministicDispatches: number;
  durationMs: number;
  tokenEfficiency: number;
  fsmPhases: string[];
}
