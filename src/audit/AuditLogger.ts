import { ConfigManager } from '../config/ConfigManager';
import { MCPToolResult } from '../types';

export class AuditLogger {
  constructor(private readonly config: ConfigManager) {}

  async logToolCall(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    result: MCPToolResult
  ): Promise<void> {
    const ts = new Date().toISOString();
    const status = result.isError ? 'ERROR' : 'OK';
    const inputStr = JSON.stringify(input);
    const entry = `[${ts}] TOOL_CALL | server=${serverName} | tool=${toolName} | status=${status} | input=${inputStr}`;
    await this.config.appendAuditLog(entry);
  }

  async logFileWrite(filePath: string, agentId: string): Promise<void> {
    const ts = new Date().toISOString();
    const entry = `[${ts}] FILE_WRITE | agent=${agentId} | path=${filePath}`;
    await this.config.appendAuditLog(entry);
  }

  async logCommand(command: string, agentId: string, approved: boolean): Promise<void> {
    const ts = new Date().toISOString();
    const action = approved ? 'APPROVED' : 'REJECTED';
    const entry = `[${ts}] TERMINAL_CMD | agent=${agentId} | status=${action} | command=${command}`;
    await this.config.appendAuditLog(entry);
  }

  async logAgentSwitch(agentId: string): Promise<void> {
    const ts = new Date().toISOString();
    const entry = `[${ts}] AGENT_SWITCH | agent=${agentId}`;
    await this.config.appendAuditLog(entry);
  }
}
