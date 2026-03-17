import { SetupWizard } from '../../ui/SetupWizard';

const showQuickPickMock = jest.fn();
const showInputBoxMock = jest.fn();

jest.mock('vscode', () => ({
  window: {
    showQuickPick: (...args: unknown[]) => showQuickPickMock(...args),
    showInputBox: (...args: unknown[]) => showInputBoxMock(...args),
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  workspace: {
    fs: {
      readFile: jest.fn().mockRejectedValue(new Error('not found')),
      writeFile: jest.fn().mockResolvedValue(undefined),
    },
  },
}));

jest.mock('../../data/DataStore', () => ({
  getAppData: () => ({
    onboarding: {
      roles: [
        { id: 'developer', description: 'Developer', recommendedAgents: ['advanced-coder'] },
      ],
      availableAgents: ['advanced-coder', 'solution-architect', 'software-qa'],
    },
    providerPresets: [
      {
        label: 'OpenAI',
        type: 'openai',
        defaultModel: 'gpt-5.1',
        authMethod: 'api_key',
        keyPlaceholder: 'sk-...'
      }
    ],
  })
}));

describe('SetupWizard simplified flow', () => {
  beforeEach(() => {
    showQuickPickMock.mockReset();
    showInputBoxMock.mockReset();
  });

  test('skips role/agent selection and installs all predefined agents', async () => {
    showQuickPickMock
      .mockResolvedValueOnce({
        label: 'OpenAI',
        description: 'Default model: gpt-5.1 · Auth: api key',
        preset: {
          label: 'OpenAI',
          type: 'openai',
          defaultModel: 'gpt-5.1',
          authMethod: 'api_key',
          keyPlaceholder: 'sk-...'
        }
      });

    showInputBoxMock
      .mockResolvedValueOnce('gpt-5.1')
      .mockResolvedValueOnce('sk-test');

    const installed: string[] = [];
    const updated: string[] = [];

    const configManager = {
      ensureBormagiDir: jest.fn().mockResolvedValue(undefined),
      writeProjectConfig: jest.fn().mockResolvedValue(undefined),
    } as any;
    const secretsManager = {
      setApiKey: jest.fn().mockResolvedValue(undefined),
    } as any;
    const agentManager = {
      installFromDirectory: jest.fn(async (_src: string, agentId: string) => { installed.push(agentId); }),
      loadAgents: jest.fn().mockResolvedValue(undefined),
      listAgents: jest.fn(() => installed.map(id => ({ id, useDefaultProvider: false }))),
      updateAgent: jest.fn(async (a: { id: string }) => { updated.push(a.id); }),
    } as any;

    const result = await SetupWizard.run(
      '/ext',
      '/workspace/project',
      configManager,
      secretsManager,
      agentManager
    );

    expect(result).not.toBeNull();
    expect(result!.role).toBe('Developer');
    expect(result!.installedAgents).toEqual(['advanced-coder', 'solution-architect', 'software-qa']);

    // Only provider selection quick-pick should run (no role pick, no agent pick).
    expect(showQuickPickMock).toHaveBeenCalledTimes(1);

    expect(installed).toEqual(['advanced-coder', 'solution-architect', 'software-qa']);
    expect(updated).toEqual(['advanced-coder', 'solution-architect', 'software-qa']);
  });
});
