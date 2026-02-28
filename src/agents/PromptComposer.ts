import { ConfigManager } from '../config/ConfigManager';
import { TemplateEngine } from '../utils/TemplateEngine';
import { AgentConfig } from '../types';

export class PromptComposer {
  constructor(private readonly config: ConfigManager) {}

  async compose(agentConfig: AgentConfig, projectName: string): Promise<string> {
    const parts: string[] = [];

    for (const filename of agentConfig.system_prompt_files) {
      const raw = await this.config.readPromptFile(agentConfig.id, filename);
      if (raw.trim()) {
        parts.push(raw);
      }
    }

    if (parts.length === 0) {
      parts.push(this.defaultPrompt(agentConfig));
    }

    const combined = parts.join('\n\n---\n\n');

    const ctx = TemplateEngine.buildContext(agentConfig.name, projectName);
    return TemplateEngine.resolve(combined, ctx);
  }

  private defaultPrompt(agentConfig: AgentConfig): string {
    return `You are ${agentConfig.name}, a ${agentConfig.category}.

${agentConfig.description}

You have access to tools that let you read and write files, run terminal commands, interact with git, and deploy to Google Cloud Platform. Always think step-by-step before acting. When you plan to modify files or run commands, clearly state what you intend to do and why.

Current project: {{project_name}}
Current date: {{date}}
Workspace: {{workspace}}`;
  }
}
