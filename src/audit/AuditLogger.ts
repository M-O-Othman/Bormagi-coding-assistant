import { ConfigManager } from '../config/ConfigManager';
import { MCPToolResult } from '../types';

export class AuditLogger {
  constructor(private readonly config: ConfigManager) {}

  private async log(record: Record<string, unknown>): Promise<void> {
    await this.config.appendAuditLog(
      JSON.stringify({ ts: new Date().toISOString(), ...record })
    );
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
      input
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
