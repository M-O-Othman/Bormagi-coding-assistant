// ─── NF2-UX-003: Role-based onboarding wizard ──────────────────────────────
//
// Shown on first launch when no .bormagi/ folder is detected.
// Guides the user through:
//   1. Role selection (Developer / Architect / Business Analyst / Reviewer)
//   2. Workspace default provider configuration (type + model)
//   3. API key entry
//   4. Predefined agent installation (pre-selected per role)
//
// Uses VS Code's native QuickPick and InputBox — no custom webview needed.

import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { AgentManager } from '../agents/AgentManager';
import { GitignoreManager } from '../config/GitignoreManager';
import { UserRole, ProjectConfig, ProviderConfig, ProviderType } from '../types';

// ─── Role → recommended agents mapping ───────────────────────────────────────

const ROLE_AGENTS: Record<UserRole, string[]> = {
  'Developer':         ['advanced-coder', 'software-qa', 'technical-writer'],
  'Architect':         ['solution-architect', 'data-architect', 'cloud-architect', 'security-engineer'],
  'Business Analyst':  ['business-analyst', 'technical-writer', 'solution-architect'],
  'Reviewer':          ['software-qa', 'security-engineer', 'technical-writer'],
};

// ─── Provider presets ─────────────────────────────────────────────────────────

interface ProviderPreset {
  label: string;
  type: ProviderType;
  defaultModel: string;
  authMethod: 'api_key' | 'gcp_adc';
  keyPlaceholder: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'OpenAI',     type: 'openai',    defaultModel: 'gpt-4o-mini',               authMethod: 'api_key', keyPlaceholder: 'sk-...' },
  { label: 'Anthropic',  type: 'anthropic', defaultModel: 'claude-haiku-4-5-20251001', authMethod: 'api_key', keyPlaceholder: 'sk-ant-...' },
  { label: 'Google AI',  type: 'gemini',    defaultModel: 'gemini-2.0-flash',          authMethod: 'api_key', keyPlaceholder: 'AIza...' },
  { label: 'DeepSeek',   type: 'deepseek',  defaultModel: 'deepseek-chat',             authMethod: 'api_key', keyPlaceholder: 'sk-...' },
  { label: 'Qwen',       type: 'qwen',      defaultModel: 'qwen-plus',                 authMethod: 'api_key', keyPlaceholder: 'sk-...' },
  { label: 'GCP (ADC) — no API key needed', type: 'gemini', defaultModel: 'gemini-2.0-flash', authMethod: 'gcp_adc', keyPlaceholder: '' },
];

// ─── Wizard result ─────────────────────────────────────────────────────────────

export interface SetupWizardResult {
  role: UserRole;
  provider: ProviderConfig;
  apiKey: string | null;   // null for gcp_adc
  installedAgents: string[];
}

// ─── SetupWizard ──────────────────────────────────────────────────────────────

export class SetupWizard {

  /**
   * Run the full onboarding wizard. Returns null if the user cancelled at any step.
   * On success: persists config and installs agents, then returns the result.
   */
  static async run(
    extensionPath: string,
    workspaceRoot: string,
    configManager: ConfigManager,
    secretsManager: SecretsManager,
    agentManager: AgentManager
  ): Promise<SetupWizardResult | null> {

    // ── Step 1: Welcome + Role selection ──────────────────────────────────────

    const roleItems = (Object.keys(ROLE_AGENTS) as UserRole[]).map(role => ({
      label: role,
      description: SetupWizard.roleDescription(role),
    }));

    const rolePick = await vscode.window.showQuickPick(roleItems, {
      title: 'Bormagi Setup (1/4) — What is your primary role?',
      placeHolder: 'Select the role that best describes how you will use Bormagi',
      ignoreFocusOut: true,
    });

    if (!rolePick) { return null; }
    const role = rolePick.label as UserRole;

    // ── Step 2: Provider selection ────────────────────────────────────────────

    const providerItems = PROVIDER_PRESETS.map(p => ({
      label: p.label,
      description: `Default model: ${p.defaultModel}`,
      preset: p,
    }));

    const providerPick = await vscode.window.showQuickPick(providerItems, {
      title: 'Bormagi Setup (2/4) — Choose a default AI provider',
      placeHolder: 'You can change this later in Agent Settings',
      ignoreFocusOut: true,
    });

    if (!providerPick) { return null; }
    const preset = providerPick.preset;

    // Allow custom model name
    const modelName = await vscode.window.showInputBox({
      title: 'Bormagi Setup (2/4) — Model name',
      prompt: `Enter the model name for ${preset.label}`,
      value: preset.defaultModel,
      ignoreFocusOut: true,
      validateInput: v => (v.trim().length === 0 ? 'Model name cannot be empty' : null),
    });

    if (modelName === undefined) { return null; }

    const provider: ProviderConfig = {
      type: preset.type,
      model: modelName.trim(),
      base_url: null,
      proxy_url: null,
      auth_method: preset.authMethod,
    };

    // ── Step 3: API key entry (skip for gcp_adc) ───────────────────────────────

    let apiKey: string | null = null;

    if (preset.authMethod === 'api_key') {
      const keyInput = await vscode.window.showInputBox({
        title: `Bormagi Setup (3/4) — ${preset.label} API key`,
        prompt: `Paste your ${preset.label} API key. It will be stored in VS Code SecretStorage (never on disk in plain text).`,
        placeHolder: preset.keyPlaceholder,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (v.trim().length === 0 ? 'API key cannot be empty' : null),
      });

      if (keyInput === undefined) { return null; }
      apiKey = keyInput.trim();
    }

    // ── Step 4: Predefined agents ──────────────────────────────────────────────

    const recommended = ROLE_AGENTS[role];
    const allAgents = [
      'solution-architect', 'data-architect', 'business-analyst', 'cloud-architect',
      'software-qa', 'frontend-designer', 'advanced-coder', 'security-engineer',
      'devops-engineer', 'technical-writer', 'ai-engineer',
    ];

    const agentItems = allAgents.map(id => ({
      label: id,
      description: recommended.includes(id) ? '★ Recommended for your role' : undefined,
      picked: recommended.includes(id),
    }));

    const agentPick = await vscode.window.showQuickPick(agentItems, {
      title: `Bormagi Setup (4/4) — Install agents (recommended for ${role} pre-selected)`,
      placeHolder: 'Select agents to install now. You can add more later.',
      canPickMany: true,
      ignoreFocusOut: true,
    });

    if (!agentPick) { return null; }
    const selectedAgentIds = agentPick.map(a => a.label);

    // ── Persist configuration ─────────────────────────────────────────────────

    await configManager.ensureBormagiDir();

    const gitignoreManager = new GitignoreManager(workspaceRoot);
    await gitignoreManager.ensureBormagiIgnored();

    const folderName = path.basename(workspaceRoot);
    const config: ProjectConfig = {
      project: { name: folderName, created_at: new Date().toISOString() },
      agents: [],
      defaultProvider: provider,
      userRole: role,
    };
    await configManager.writeProjectConfig(config);

    // Store API key under workspace default
    if (apiKey) {
      await secretsManager.setApiKey('__default__', apiKey);
    }

    // Install selected agents and apply default provider to all
    let installed = 0;
    const predefinedDir = path.join(extensionPath, 'predefined-agents');
    for (const agentId of selectedAgentIds) {
      const srcDir = path.join(predefinedDir, agentId);
      await agentManager.installFromDirectory(srcDir, agentId);
      installed++;
    }

    await agentManager.loadAgents();

    // Apply workspace default to all newly installed agents
    const agents = agentManager.listAgents();
    for (const agent of agents) {
      const updated = { ...agent, useDefaultProvider: true };
      await agentManager.updateAgent(updated);
    }

    return { role, provider, apiKey, installedAgents: selectedAgentIds };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private static roleDescription(role: UserRole): string {
    switch (role) {
      case 'Developer':        return 'Write, test, and ship code — coder, QA, and writer agents pre-selected';
      case 'Architect':        return 'Design systems and make technology decisions — architect agents pre-selected';
      case 'Business Analyst': return 'Gather requirements and document solutions — analyst and writer agents pre-selected';
      case 'Reviewer':         return 'Review code, security, and documentation — QA and security agents pre-selected';
    }
  }

  /**
   * Return the agent IDs in role-ranked order for a given role.
   * Recommended agents come first; others follow alphabetically.
   */
  static rankAgentsForRole(agentIds: string[], role: UserRole | undefined): string[] {
    if (!role) { return agentIds; }
    const recommended = new Set(ROLE_AGENTS[role]);
    const ranked = agentIds.filter(id => recommended.has(id));
    const rest = agentIds.filter(id => !recommended.has(id)).sort();
    return [...ranked, ...rest];
  }

  /**
   * Recommended workflow template IDs for each role.
   * Used to surface the most relevant templates first in the workflow creation wizard.
   */
  static recommendedWorkflowTemplates(role: UserRole | undefined): string[] {
    switch (role) {
      case 'Developer':        return ['feature-delivery', 'bug-fix'];
      case 'Architect':        return ['architecture-spike', 'feature-delivery'];
      case 'Business Analyst': return ['feature-delivery', 'architecture-spike'];
      case 'Reviewer':         return ['bug-fix', 'feature-delivery'];
      default:                 return ['feature-delivery', 'bug-fix', 'architecture-spike'];
    }
  }
}
