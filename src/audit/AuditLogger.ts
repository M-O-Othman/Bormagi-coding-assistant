import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { MCPToolResult } from '../types';

const GENESIS_HASH = '0'.repeat(64);

export class AuditLogger {
  /** In-memory chain head. Undefined until first log() call triggers lazy init. */
  private prevHash: string | undefined;

  constructor(private readonly config: ConfigManager) {}

  // ─── NF2-SEC-002: Rolling HMAC chain ────────────────────────────────────────

  /**
   * Read the last JSONL line in the audit log and return its `entry_hash`.
   * Falls back to GENESIS_HASH when the file is absent or the last line has no chain fields.
   */
  private loadLastHash(): string {
    const logPath = this.config.auditLogPath;
    if (!fs.existsSync(logPath)) { return GENESIS_HASH; }
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) { return GENESIS_HASH; }
    try {
      const parsed = JSON.parse(lines[lines.length - 1]);
      return typeof parsed.entry_hash === 'string' ? parsed.entry_hash : GENESIS_HASH;
    } catch {
      return GENESIS_HASH;
    }
  }

  private async log(record: Record<string, unknown>): Promise<void> {
    // Lazy chain initialisation — pick up from last persisted entry on restart.
    if (this.prevHash === undefined) {
      this.prevHash = this.loadLastHash();
    }

    const ts = new Date().toISOString();
    // Core payload used as HMAC input: timestamp + all record fields (no chain fields).
    const corePayload = JSON.stringify({ ts, ...record });
    const hmacKey = vscode.env.machineId;
    const entryHash = crypto.createHmac('sha256', hmacKey)
      .update(corePayload + this.prevHash)
      .digest('hex');

    const line = JSON.stringify({ ts, ...record, prev_hash: this.prevHash, entry_hash: entryHash });
    this.prevHash = entryHash;
    await this.config.appendAuditLog(line);
  }

  /**
   * Sanitise a tool-call input object before writing it to the audit log.
   * - write_file: replaces `content` with a character count to avoid persisting
   *   full file contents (which may include secrets, PII, or proprietary code).
   * - run_command / git_commit / gcp_deploy: kept as-is (commands are short strings).
   * - All other string values are truncated to 500 chars.
   */
  private sanitiseInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (toolName === 'write_file' && key === 'content' && typeof value === 'string') {
        safe[key] = `[${value.length} chars redacted]`;
      } else if (typeof value === 'string' && value.length > 500) {
        safe[key] = value.slice(0, 500) + '…[truncated]';
      } else {
        safe[key] = value;
      }
    }
    return safe;
  }

  async logToolCall(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    result: MCPToolResult
  ): Promise<void> {
    await this.log({
      event: 'TOOL_CALL',
      server: serverName,
      tool: toolName,
      status: result.isError ? 'ERROR' : 'OK',
      input: this.sanitiseInput(toolName, input)
    });
  }

  async logFileWrite(filePath: string, agentId: string): Promise<void> {
    await this.log({ event: 'FILE_WRITE', agent: agentId, path: filePath });
  }

  async logCommand(command: string, agentId: string, approved: boolean): Promise<void> {
    await this.log({
      event: 'TERMINAL_CMD',
      agent: agentId,
      status: approved ? 'APPROVED' : 'REJECTED',
      command
    });
  }

  async logAgentSwitch(agentId: string): Promise<void> {
    await this.log({ event: 'AGENT_SWITCH', agent: agentId });
  }

  async logTokenUsage(
    agentId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number
  ): Promise<void> {
    await this.log({ event: 'TOKEN_USAGE', agent: agentId, provider, model, inputTokens, outputTokens, costUsd });
  }

  async logLLMRequest(
    agentId: string,
    provider: string,
    model: string,
    metrics: {
      phase: string;
      systemChars: number;
      historyChars: number;
      repoSummaryChars: number;
      retrievalChars: number;
      userChars: number;
      toolSchemaChars: number;
      totalChars: number;
      totalBytes: number;
      estimatedInputTokens: number;
      contextCacheHit?: boolean;
    }
  ): Promise<void> {
    await this.log({
      event: 'LLM_REQUEST',
      agent: agentId,
      provider,
      model,
      ...metrics
    });
  }

  async logLLMResponseHeaders(
    agentId: string,
    provider: string,
    model: string,
    headers: Record<string, string>
  ): Promise<void> {
    const compact: Record<string, string> = {};
    const keys = Object.keys(headers).sort().slice(0, 64);
    for (const key of keys) {
      const value = headers[key] ?? '';
      compact[key] = value.length > 200 ? `${value.slice(0, 197)}...` : value;
    }

    await this.log({
      event: 'LLM_RESPONSE_HEADERS',
      agent: agentId,
      provider,
      model,
      headers: compact
    });
  }

  // ─── WF-701: Structured workflow events ────────────────────────────────────────

  async logWorkflowCreated(workflowId: string, title: string, templateId: string, humanOwner: string): Promise<void> {
    await this.log({ event: 'WF_CREATED', workflowId, title, templateId, humanOwner });
  }

  async logStageTransition(workflowId: string, fromStageId: string | null, toStageId: string, triggeredBy: string): Promise<void> {
    await this.log({ event: 'WF_STAGE_TRANSITION', workflowId, fromStageId, toStageId, triggeredBy });
  }

  async logTaskDelegated(
    workflowId: string,
    taskId: string,
    fromAgentId: string,
    toAgentId: string,
    handoffId: string
  ): Promise<void> {
    await this.log({ event: 'WF_DELEGATION', workflowId, taskId, fromAgentId, toAgentId, handoffId });
  }

  async logReviewCompleted(
    workflowId: string,
    reviewId: string,
    taskId: string,
    outcome: string,
    reviewerAgentId: string
  ): Promise<void> {
    await this.log({ event: 'WF_REVIEW_COMPLETED', workflowId, reviewId, taskId, outcome, reviewerAgentId });
  }

  async logBlockerRaised(
    workflowId: string,
    blockerId: string,
    taskId: string,
    severity: string,
    raisedByAgentId: string
  ): Promise<void> {
    await this.log({ event: 'WF_BLOCKER_RAISED', workflowId, blockerId, taskId, severity, raisedByAgentId });
  }

  async logBlockerResolved(
    workflowId: string,
    blockerId: string,
    taskId: string,
    resolvedBy: string
  ): Promise<void> {
    await this.log({ event: 'WF_BLOCKER_RESOLVED', workflowId, blockerId, taskId, resolvedBy });
  }

  async logOverrideApplied(
    workflowId: string,
    permission: string,
    performedBy: string,
    reason: string,
    targetId?: string
  ): Promise<void> {
    await this.log({ event: 'WF_OVERRIDE', workflowId, permission, performedBy, reason, targetId: targetId ?? null });
  }

  async logWorkflowCancelled(workflowId: string, reason: string, cancelledBy: string): Promise<void> {
    await this.log({ event: 'WF_CANCELLED', workflowId, reason, cancelledBy });
  }

  async logApprovalCheckpointGranted(
    workflowId: string,
    checkpointId: string,
    grantedBy: string
  ): Promise<void> {
    await this.log({ event: 'WF_APPROVAL_GRANTED', workflowId, checkpointId, grantedBy });
  }

  // ─── NF2-AI-002: Prompt injection detection ────────────────────────────────

  /**
   * Log a detected prompt injection attempt in a structured completion payload.
   * The `offendingFields` list names the affected fields; actual content is NOT
   * written to the log to avoid persisting adversarial text.
   */
  async logPromptInjectionAttempt(agentId: string, offendingFields: string[]): Promise<void> {
    await this.log({
      event: 'PROMPT_INJECTION_DETECTED',
      agent: agentId,
      offendingFields,
      note: 'Offending content stripped from structured completion payload.',
    });
  }
}
