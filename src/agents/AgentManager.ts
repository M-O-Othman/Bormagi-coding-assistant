import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { MCPHost } from '../mcp/MCPHost';
import { AgentConfig, ProjectConfig } from '../types';

export class AgentManager {
  private agents = new Map<string, AgentConfig>();

  constructor(
    private readonly config: ConfigManager,
    private readonly secrets: SecretsManager,
    private readonly mcpHost: MCPHost
  ) {}

  async loadAgents(): Promise<void> {
    this.agents.clear();
    const ids = await this.config.listAgentIds();
    for (const id of ids) {
      const agentConfig = await this.config.readAgentConfig(id);
      if (agentConfig && agentConfig.enabled) {
        this.agents.set(id, agentConfig);
      }
    }
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  async createAgent(config: AgentConfig): Promise<void> {
    await this.config.writeAgentConfig(config);
    this.agents.set(config.id, config);
    await this.updateProjectAgentList();

    // Create default system prompt if none provided
    const existingPrompt = await this.config.readPromptFile(config.id, 'system-prompt.md');
    if (!existingPrompt) {
      await this.config.writePromptFile(config.id, 'system-prompt.md',
        `# ${config.name} — System Prompt\n\n` +
        `You are ${config.name}, a ${config.category}.\n\n` +
        `${config.description}\n\n` +
        `Current project: {{project_name}}\n` +
        `Workspace: {{workspace}}\n` +
        `Date: {{date}}\n`
      );
    }
  }

  async updateAgent(config: AgentConfig): Promise<void> {
    await this.config.writeAgentConfig(config);
    this.agents.set(config.id, config);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.config.deleteAgentConfig(id);
    this.agents.delete(id);
    await this.updateProjectAgentList();
  }

  async setApiKey(agentId: string, apiKey: string): Promise<void> {
    await this.secrets.setApiKey(agentId, apiKey);
  }

  async getApiKey(agentId: string): Promise<string> {
    return (await this.secrets.getApiKey(agentId)) ?? '';
  }

  async startMCPServersForAgent(agentId: string, workspaceRoot: string): Promise<void> {
    const agentConfig = this.agents.get(agentId);
    if (!agentConfig) {
      return;
    }

    // Start built-in servers
    await this.mcpHost.startBuiltin('filesystem', workspaceRoot);
    await this.mcpHost.startBuiltin('terminal', workspaceRoot);
    await this.mcpHost.startBuiltin('git', workspaceRoot);
    await this.mcpHost.startBuiltin('gcp', workspaceRoot);

    // Start any custom MCP servers defined for this agent
    for (const serverConfig of agentConfig.mcp_servers) {
      try {
        await this.mcpHost.startServer(serverConfig);
      } catch (err) {
        console.error(`Bormagi: Failed to start MCP server "${serverConfig.name}": ${err}`);
      }
    }
  }

  /**
   * Install an agent from a predefined agent source directory into the workspace.
   */
  async installFromDirectory(srcDir: string, agentId: string): Promise<void> {
    const srcUri = vscode.Uri.file(srcDir);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(srcUri);
    } catch {
      console.warn(`Bormagi: Predefined agent directory not found: ${srcDir}`);
      return;
    }

    for (const [filename] of entries) {
      const srcFile = vscode.Uri.file(path.join(srcDir, filename));
      const raw = await vscode.workspace.fs.readFile(srcFile);
      const content = Buffer.from(raw).toString('utf8');

      if (filename === 'config.json') {
        const agentConfig = JSON.parse(content) as AgentConfig;
        await this.config.writeAgentConfig(agentConfig);
        this.agents.set(agentConfig.id, agentConfig);
      } else {
        await this.config.writePromptFile(agentId, filename, content);
      }
    }

    await this.updateProjectAgentList();
  }

  private async updateProjectAgentList(): Promise<void> {
    const existing = await this.config.readProjectConfig();
    const agentIds = [...this.agents.keys()];
    const updated: ProjectConfig = existing
      ? { ...existing, agents: agentIds }
      : {
          project: {
            name: path.basename(this.config.bormagiDir.replace('/.bormagi', '').replace('\\.bormagi', '')),
            created_at: new Date().toISOString()
          },
          agents: agentIds
        };
    await this.config.writeProjectConfig(updated);
  }
}
