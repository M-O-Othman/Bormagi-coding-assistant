import { ConfigManager } from '../config/ConfigManager';
import { TemplateEngine } from '../utils/TemplateEngine';
import { AgentConfig } from '../types';
import { getAppData } from '../data/DataStore';

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
    // Load from prompts/default-system-prompt.md and substitute agent-specific fields.
    // Remaining {{project_name}}, {{date}}, {{workspace}} are resolved by TemplateEngine.resolve().
    return getAppData().defaultSystemPrompt
      .replace(/\{\{name\}\}/g, agentConfig.name)
      .replace(/\{\{category\}\}/g, agentConfig.category)
      .replace(/\{\{description\}\}/g, agentConfig.description);
  }
}
