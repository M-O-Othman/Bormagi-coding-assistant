// ─── NF2-UX-003: Simplified onboarding wizard ──────────────────────────────
//
// Shown on first launch when no .bormagi/ folder is detected.
// Guides the user through:
//   1. Workspace default provider configuration (type + model)
//   2. API key/token entry (when required)
//
// Then installs all predefined agents by default.
//
// Uses VS Code's native QuickPick and InputBox — no custom webview needed.

import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { SecretsManager } from '../config/SecretsManager';
import { AgentManager } from '../agents/AgentManager';
import { GitignoreManager } from '../config/GitignoreManager';
import { UserRole, ProjectConfig, ProviderConfig, AuthMethod } from '../types';
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

    // ── Step 1: Provider selection ───────────────────────────────────────────

    const { onboarding, providerPresets } = getAppData();
    const role: UserRole = 'Developer';

    const providerItems = providerPresets.map(p => ({
      label: p.label,
      description: `Default model: ${p.defaultModel} · Auth: ${p.authMethod.replace('_', ' ')}`,
      preset: p,
    }));

    const providerPick = await vscode.window.showQuickPick(providerItems, {
      title: 'Bormagi Setup (1/2) — Choose a default AI provider',
      placeHolder: 'You can change this later in Agent Settings',
      ignoreFocusOut: true,
    });

    if (!providerPick) { return null; }
    const preset = providerPick.preset;

    // Allow custom model name
    const modelName = await vscode.window.showInputBox({
      title: 'Bormagi Setup (1/2) — Model name',
      prompt: `Enter the model name for ${preset.label}`,
      value: preset.defaultModel,
      ignoreFocusOut: true,
      validateInput: v => (v.trim().length === 0 ? 'Model name cannot be empty' : null),
    });

    if (modelName === undefined) { return null; }

    let selectedAuthMethod = preset.authMethod;

    // If provider supports multiple auth methods, ask explicitly.
    if (preset.type === 'anthropic' || preset.type === 'gemini') {
      const authItems: Array<{ label: string; value: AuthMethod; description: string }> = preset.type === 'anthropic'
        ? [
            { label: 'API Key', value: 'api_key', description: 'Standard Anthropic API key' },
            { label: 'Claude Subscription Token', value: 'subscription', description: 'Use Anthropic auth token from subscription session' },
          ]
        : [
            { label: 'API Key', value: 'api_key', description: 'Google AI Studio API key' },
            { label: 'OAuth via Proxy', value: 'oauth_proxy', description: 'Bearer identity via proxy' },
            { label: 'Vertex AI (ADC/OAuth)', value: 'vertex_ai', description: 'Use gcloud ADC token flow' },
          ];

      const authPick = await vscode.window.showQuickPick<{ label: string; value: AuthMethod; description: string }>(authItems, {
        title: 'Bormagi Setup (1/2) — Authentication method',
        placeHolder: `Choose auth method for ${preset.label}`,
        ignoreFocusOut: true,
      });

      if (!authPick) { return null; }
      selectedAuthMethod = authPick.value;
    }

    // ── Step 2b: Base URL (required for openai_compatible only) ───────────────

    let customBaseUrl: string | null = null;

    if (preset.type === 'openai_compatible') {
      const urlInput = await vscode.window.showInputBox({
        title: 'Bormagi Setup (1/2) — API base URL',
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
      auth_method: selectedAuthMethod,
    };

    // ── Step 2: API key/token entry (skip for non-key methods) ───────────────

    let apiKey: string | null = null;

    if (selectedAuthMethod === 'api_key' || selectedAuthMethod === 'subscription') {
      const keyOptional = preset.type === 'openai_compatible';
      const keyInput = await vscode.window.showInputBox({
        title: selectedAuthMethod === 'subscription'
          ? `Bormagi Setup (2/2) — ${preset.label} subscription token`
          : `Bormagi Setup (2/2) — ${preset.label} API key`,
        prompt: selectedAuthMethod === 'subscription'
          ? `Paste your ${preset.label} auth token from your subscription session. Stored in VS Code SecretStorage.`
          : (keyOptional
            ? 'Paste your API key, or leave blank if the endpoint does not require one (e.g. Ollama).'
            : `Paste your ${preset.label} API key. It will be stored in VS Code SecretStorage (never on disk in plain text).`),
        placeHolder: preset.keyPlaceholder,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (!keyOptional && v.trim().length === 0 ? (selectedAuthMethod === 'subscription' ? 'Subscription token cannot be empty' : 'API key cannot be empty') : null),
      });

      if (keyInput === undefined) { return null; }
      apiKey = keyInput.trim() || null;
    }

    // ── Step 3: Install all predefined agents by default ──────────────────────
    const selectedAgentIds = onboarding.availableAgents.slice();

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
