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
import { UserRole, ProjectConfig, ProviderConfig } from '../types';
import { getAppData } from '../data/DataStore';

// ─── Wizard result ─────────────────────────────────────────────────────────────

export interface SetupWizardResult {
  role: UserRole;
  provider: ProviderConfig;
  apiKey: string | null;   // null for OAuth/Vertex modes
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

    const { onboarding, providerPresets } = getAppData();
    const roleItems = onboarding.roles.map(r => ({
      label: r.id as UserRole,
      description: r.description,
    }));

    const rolePick = await vscode.window.showQuickPick(roleItems, {
      title: 'Bormagi Setup (1/4) — What is your primary role?',
      placeHolder: 'Select the role that best describes how you will use Bormagi',
      ignoreFocusOut: true,
    });

    if (!rolePick) { return null; }
    const role = rolePick.label as UserRole;

    // ── Step 2: Provider selection ────────────────────────────────────────────

    const providerItems = providerPresets.map(p => ({
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

    // ── Step 2b: Base URL (required for openai_compatible only) ───────────────

    let customBaseUrl: string | null = null;

    if (preset.type === 'openai_compatible') {
      const urlInput = await vscode.window.showInputBox({
        title: 'Bormagi Setup (2/4) — API base URL',
        prompt: 'Enter the OpenAI-compatible API base URL for this provider.',
        placeHolder: 'e.g. http://localhost:11434/v1  (Ollama)  or  https://openrouter.ai/api/v1',
        ignoreFocusOut: true,
        validateInput: v => (v.trim().length === 0 ? 'Base URL cannot be empty' : null),
      });

      if (urlInput === undefined) { return null; }
      customBaseUrl = urlInput.trim();
    }

    const provider: ProviderConfig = {
      type: preset.type,
      model: modelName.trim(),
      base_url: customBaseUrl,
      proxy_url: null,
      auth_method: preset.authMethod,
    };

    // ── Step 3: API key entry (skip for non-api_key auth; optional for openai_compatible) ──

    let apiKey: string | null = null;

    if (preset.authMethod === 'api_key') {
      const keyOptional = preset.type === 'openai_compatible';
      const keyInput = await vscode.window.showInputBox({
        title: `Bormagi Setup (3/4) — ${preset.label} API key`,
        prompt: keyOptional
          ? 'Paste your API key, or leave blank if the endpoint does not require one (e.g. Ollama).'
          : `Paste your ${preset.label} API key. It will be stored in VS Code SecretStorage (never on disk in plain text).`,
        placeHolder: preset.keyPlaceholder,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (!keyOptional && v.trim().length === 0 ? 'API key cannot be empty' : null),
      });

      if (keyInput === undefined) { return null; }
      apiKey = keyInput.trim() || null;
    }

    // ── Step 4: Predefined agents ──────────────────────────────────────────────

    const recommended = onboarding.roles.find(r => r.id === role)?.recommendedAgents ?? [];
    const allAgents = onboarding.availableAgents;

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

  /**
   * Return the agent IDs in role-ranked order for a given role.
   * Recommended agents come first; others follow alphabetically.
   */
  static rankAgentsForRole(agentIds: string[], role: UserRole | undefined): string[] {
    if (!role) { return agentIds; }
    const roleData = getAppData().onboarding.roles.find(r => r.id === role);
    const recommended = new Set(roleData?.recommendedAgents ?? []);
    const ranked = agentIds.filter(id => recommended.has(id));
    const rest = agentIds.filter(id => !recommended.has(id)).sort();
    return [...ranked, ...rest];
  }

  /**
   * Recommended workflow template IDs for each role (loaded from data/onboarding.json).
   * Used to surface the most relevant templates first in the workflow creation wizard.
   */
  static recommendedWorkflowTemplates(role: UserRole | undefined): string[] {
    if (!role) { return ['feature-delivery', 'bug-fix', 'architecture-spike']; }
    const roleData = getAppData().onboarding.roles.find(r => r.id === role);
    return roleData?.recommendedWorkflows ?? ['feature-delivery', 'bug-fix', 'architecture-spike'];
  }
}
