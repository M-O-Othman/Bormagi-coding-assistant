import { ConfigManager } from '../config/ConfigManager';

/**
 * Skills are shared .md files that all agents in the workspace can use.
 * They are loaded and injected into the system prompt as an appendix.
 */
export class SkillManager {
  private cache: Map<string, string> = new Map();

  constructor(private readonly config: ConfigManager) {}

  async loadAll(): Promise<void> {
    this.cache.clear();
    const skillNames = await this.config.listSkills();
    for (const name of skillNames) {
      const content = await this.config.readSkill(name);
      this.cache.set(name, content);
    }
  }

  getSkillNames(): string[] {
    return [...this.cache.keys()];
  }

  getSkillContent(name: string): string {
    return this.cache.get(name) ?? '';
  }

  buildSkillsPromptSection(): string {
    if (this.cache.size === 0) {
      return '';
    }

    const parts = ['## Available Skills\n'];
    for (const [name, content] of this.cache) {
      parts.push(`### Skill: ${name}\n\n${content}`);
    }
    return parts.join('\n\n');
  }

  async saveSkill(name: string, content: string): Promise<void> {
    await this.config.writeSkill(name, content);
    this.cache.set(name, content);
  }
}
