import { ConfigManager } from '../config/ConfigManager';
import { MCPToolResult } from '../types';

export class AuditLogger {
  constructor(private readonly config: ConfigManager) {}

  private async log(record: Record<string, unknown>): Promise<void> {
    await this.config.appendAuditLog(
      JSON.stringify({ ts: new Date().toISOString(), ...record })
    );
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
}
