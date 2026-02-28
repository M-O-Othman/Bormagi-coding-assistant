import * as vscode from 'vscode';
import * as path from 'path';
import { AgentConfig, ProjectConfig } from '../types';

const BORMAGI_DIR = '.bormagi';
const AGENTS_DIR = 'agents-definition';
const SKILLS_DIR = 'skills';
const PROJECT_FILE = 'project.json';
const AUDIT_FILE = 'audit.log';

export class ConfigManager {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  get bormagiDir(): string {
    return path.join(this.workspaceRoot, BORMAGI_DIR);
  }

  get agentsDir(): string {
    return path.join(this.bormagiDir, AGENTS_DIR);
  }

  get skillsDir(): string {
    return path.join(this.bormagiDir, SKILLS_DIR);
  }

  get auditLogPath(): string {
    return path.join(this.bormagiDir, AUDIT_FILE);
  }

  agentDir(agentId: string): string {
    return path.join(this.agentsDir, agentId);
  }

  agentConfigPath(agentId: string): string {
    return path.join(this.agentDir(agentId), 'config.json');
  }

  agentMemoryPath(agentId: string): string {
    return path.join(this.agentDir(agentId), 'Memory.md');
  }

  async ensureBormagiDir(): Promise<void> {
    const uri = vscode.Uri.file(this.bormagiDir);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(uri);
    }

    const agentsUri = vscode.Uri.file(this.agentsDir);
    try {
      await vscode.workspace.fs.stat(agentsUri);
    } catch {
      await vscode.workspace.fs.createDirectory(agentsUri);
    }

    const skillsUri = vscode.Uri.file(this.skillsDir);
    try {
      await vscode.workspace.fs.stat(skillsUri);
    } catch {
      await vscode.workspace.fs.createDirectory(skillsUri);
    }
  }

  async readProjectConfig(): Promise<ProjectConfig | null> {
    const filePath = path.join(this.bormagiDir, PROJECT_FILE);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return JSON.parse(Buffer.from(raw).toString('utf8')) as ProjectConfig;
    } catch {
      return null;
    }
  }

  async writeProjectConfig(config: ProjectConfig): Promise<void> {
    const filePath = path.join(this.bormagiDir, PROJECT_FILE);
    const content = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(content, 'utf8')
    );
  }

  async readAgentConfig(agentId: string): Promise<AgentConfig | null> {
    const filePath = this.agentConfigPath(agentId);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return JSON.parse(Buffer.from(raw).toString('utf8')) as AgentConfig;
    } catch {
      return null;
    }
  }

  async writeAgentConfig(config: AgentConfig): Promise<void> {
    const dir = this.agentDir(config.id);
    const dirUri = vscode.Uri.file(dir);
    try {
      await vscode.workspace.fs.stat(dirUri);
    } catch {
      await vscode.workspace.fs.createDirectory(dirUri);
    }

    const filePath = this.agentConfigPath(config.id);
    const content = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(content, 'utf8')
    );
  }

  async deleteAgentConfig(agentId: string): Promise<void> {
    const dirUri = vscode.Uri.file(this.agentDir(agentId));
    try {
      await vscode.workspace.fs.delete(dirUri, { recursive: true });
    } catch {
      // Directory may not exist; ignore
    }
  }

  async listAgentIds(): Promise<string[]> {
    const dirUri = vscode.Uri.file(this.agentsDir);
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      return entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  async readPromptFile(agentId: string, filename: string): Promise<string> {
    const filePath = path.join(this.agentDir(agentId), filename);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(raw).toString('utf8');
    } catch {
      return '';
    }
  }

  async writePromptFile(agentId: string, filename: string, content: string): Promise<void> {
    const dir = this.agentDir(agentId);
    const dirUri = vscode.Uri.file(dir);
    try {
      await vscode.workspace.fs.stat(dirUri);
    } catch {
      await vscode.workspace.fs.createDirectory(dirUri);
    }
    const filePath = path.join(dir, filename);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(content, 'utf8')
    );
  }

  async listSkills(): Promise<string[]> {
    const dirUri = vscode.Uri.file(this.skillsDir);
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
        .map(([name]) => name.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }

  async readSkill(skillName: string): Promise<string> {
    const filePath = path.join(this.skillsDir, `${skillName}.md`);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(raw).toString('utf8');
    } catch {
      return '';
    }
  }

  async writeSkill(skillName: string, content: string): Promise<void> {
    const filePath = path.join(this.skillsDir, `${skillName}.md`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(content, 'utf8')
    );
  }

  async appendMemory(agentId: string, entry: string): Promise<void> {
    const filePath = this.agentMemoryPath(agentId);
    let existing = '';
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      existing = Buffer.from(raw).toString('utf8');
    } catch {
      existing = '# Conversation Memory\n\n';
    }
    const updated = existing + entry + '\n';
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(updated, 'utf8')
    );
  }

  async readMemory(agentId: string): Promise<string> {
    const filePath = this.agentMemoryPath(agentId);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(raw).toString('utf8');
    } catch {
      return '';
    }
  }

  async appendAuditLog(entry: string): Promise<void> {
    const filePath = this.auditLogPath;
    let existing = '';
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      existing = Buffer.from(raw).toString('utf8');
    } catch {
      existing = '';
    }
    const updated = existing + entry + '\n';
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(updated, 'utf8')
    );
  }
}
