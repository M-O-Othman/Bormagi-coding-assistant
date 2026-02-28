import * as vscode from 'vscode';

/**
 * Wraps VS Code's SecretStorage API.
 * API keys are never written to disk — stored in VS Code's encrypted secret store.
 */
export class SecretsManager {
  private static readonly PREFIX = 'bormagi.apikey.';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async setApiKey(agentId: string, key: string): Promise<void> {
    await this.secrets.store(SecretsManager.PREFIX + agentId, key);
  }

  async getApiKey(agentId: string): Promise<string | undefined> {
    return this.secrets.get(SecretsManager.PREFIX + agentId);
  }

  async deleteApiKey(agentId: string): Promise<void> {
    await this.secrets.delete(SecretsManager.PREFIX + agentId);
  }

  async hasApiKey(agentId: string): Promise<boolean> {
    const key = await this.getApiKey(agentId);
    return key !== undefined && key.length > 0;
  }
}
