import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { initDataStore } from './data/DataStore';
import { ConfigManager } from './config/ConfigManager';
import { verifyAuditLog } from './audit/AuditVerifier';
import { SecretsManager } from './config/SecretsManager';
import { GitignoreManager } from './config/GitignoreManager';
import { AgentManager } from './agents/AgentManager';
import { AgentRunner } from './agents/AgentRunner';
import { MemoryManager } from './agents/MemoryManager';
import { UndoManager } from './agents/UndoManager';
import { SkillManager } from './skills/SkillManager';
import { PromptComposer } from './agents/PromptComposer';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { ChatController } from './chat/ChatController';
import { AgentSettingsPanel } from './ui/AgentSettingsPanel';
import { MainPanel } from './ui/MainPanel';
import { MeetingPanel } from './ui/MeetingPanel';
import { StatusBar } from './ui/StatusBar';
import { SetupWizard } from './ui/SetupWizard';
import { AuditLogger } from './audit/AuditLogger';
import { MCPHost } from './mcp/MCPHost';
import { ProjectConfig } from './types';

let configManager: ConfigManager | undefined;
let secretsManager: SecretsManager | undefined;
let agentManager: AgentManager | undefined;
let chatController: ChatController | undefined;
let mcpHost: MCPHost | undefined;
let statusBar: StatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialise DataStore first — all other components depend on it.
  await initDataStore(context.extensionPath);

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  // For multi-root workspaces, prompt the user to choose a folder.
  // Single-root workspaces skip the picker automatically.
  let workspaceRoot: string;
  if (workspaceFolders.length === 1) {
    workspaceRoot = workspaceFolders[0].uri.fsPath;
  } else {
    const pick = await vscode.window.showQuickPick(
      workspaceFolders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: 'Bormagi — Select workspace folder', placeHolder: 'Choose the root folder for this Bormagi session' }
    );
    if (!pick) {
      return; // User dismissed the picker; activate silently
    }
    workspaceRoot = pick.folder.uri.fsPath;
  }

  // ─── Core services ────────────────────────────────────────────────────────
  configManager = new ConfigManager(workspaceRoot);
  secretsManager = new SecretsManager(context.secrets);
  const gitignoreManager = new GitignoreManager(workspaceRoot);
  const auditLogger = new AuditLogger(configManager);
  mcpHost = new MCPHost(context.extensionPath, auditLogger);
  agentManager = new AgentManager(configManager, secretsManager, mcpHost);
  statusBar = new StatusBar();

  const memoryManager  = new MemoryManager(configManager);
  const undoManager    = new UndoManager();
  const skillManager   = new SkillManager(configManager);
  const promptComposer = new PromptComposer(configManager);
  const runner = new AgentRunner(
    agentManager, mcpHost, promptComposer, memoryManager,
    undoManager, skillManager, auditLogger, configManager, workspaceRoot
  );
  chatController = new ChatController(agentManager, configManager, auditLogger, statusBar, runner, undoManager);

  // ─── Main Dashboard panel (configure singleton before any command fires) ──
  MainPanel.configure({
    extensionUri: context.extensionUri,
    extensionPath: context.extensionPath,
    chatController,
    agentManager,
    configManager,
    secretsManager,
  });

  // ─── Sidebar chat WebView ─────────────────────────────────────────────────
  const chatViewProvider = new ChatViewProvider(context.extensionUri, chatController);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('bormagi.chatView', chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  statusBar.register(context);

  // ─── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('bormagi.initialiseWorkspace', async () => {
      await initialiseWorkspace(workspaceRoot, configManager!, gitignoreManager);
    }),

    vscode.commands.registerCommand('bormagi.openSettings', () => {
      AgentSettingsPanel.createOrShow(context.extensionUri, agentManager!, secretsManager!, configManager!);
    }),

    vscode.commands.registerCommand('bormagi.newAgent', () => {
      AgentSettingsPanel.createOrShow(context.extensionUri, agentManager!, secretsManager!, configManager!, 'new');
    }),

    vscode.commands.registerCommand('bormagi.installPredefinedAgents', async () => {
      await installPredefinedAgents(context.extensionPath, configManager!, agentManager!);
    }),

    vscode.commands.registerCommand('bormagi.openChat', () => {
      vscode.commands.executeCommand('bormagi.chatView.focus');
    }),

    vscode.commands.registerCommand('bormagi.selectAgent', async () => {
      await selectAgentCommand(agentManager!, chatController!);
    }),

    vscode.commands.registerCommand('bormagi.openDashboard', () => {
      MainPanel.createOrShow();
    }),

    vscode.commands.registerCommand('bormagi.startMeeting', async () => {
      if (!workspaceRoot || !agentManager || !configManager || !secretsManager) {
        vscode.window.showWarningMessage('Bormagi: Initialise the workspace first.');
        return;
      }
      await MeetingPanel.createOrShow(context.extensionUri, agentManager, configManager, workspaceRoot, secretsManager);
    }),

    vscode.commands.registerCommand('bormagi.showAuditLog', async () => {
      const logPath = configManager!.auditLogPath;
      const uri = vscode.Uri.file(logPath);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.window.showTextDocument(uri);
      } catch {
        vscode.window.showInformationMessage('Bormagi: No audit log found. Initialise the workspace first.');
      }
    }),

    // ─── NF2-SEC-002: Audit log integrity verification ─────────────────────
    vscode.commands.registerCommand('bormagi.verifyAuditLog', () => {
      const logPath = configManager!.auditLogPath;
      if (!fs.existsSync(logPath)) {
        vscode.window.showInformationMessage('Bormagi: No audit log found.');
        return;
      }

      const { ok, legacy, broken } = verifyAuditLog(logPath, vscode.env.machineId);

      if (broken.length === 0) {
        vscode.window.showInformationMessage(
          `Bormagi: Audit log verified. ${ok} chained entr${ok === 1 ? 'y' : 'ies'} OK` +
          (legacy > 0 ? `, ${legacy} legacy (pre-chain).` : '.')
        );
      } else {
        vscode.window.showWarningMessage(
          `Bormagi: Audit log integrity FAILED — broken at line${broken.length > 1 ? 's' : ''}: ` +
          `${broken.join(', ')}. ${ok} OK, ${legacy} legacy.`
        );
      }
    })
  );

  // ─── Auto-initialise or run first-launch wizard ───────────────────────────
  const existingConfig = await configManager.readProjectConfig();
  if (existingConfig) {
    await agentManager.loadAgents();
    statusBar.update(chatController.activeAgentName);
  } else {
    // No .bormagi/ config found — offer the onboarding wizard on first launch.
    // Use a slight delay so the sidebar has time to render before the wizard opens.
    setTimeout(async () => {
      const result = await SetupWizard.run(
        context.extensionPath,
        workspaceRoot,
        configManager!,
        secretsManager!,
        agentManager!
      );
      if (result) {
        statusBar!.update(chatController!.activeAgentName);
        vscode.window.showInformationMessage(
          `Bormagi is ready! Role: ${result.role} · ${result.installedAgents.length} agent(s) installed.`
        );
      } else {
        // Wizard cancelled — surface a manual init command hint
        vscode.window.showInformationMessage(
          'Bormagi: Run "Bormagi: Initialise Workspace" to set up the extension when ready.',
          'Initialise'
        ).then(action => {
          if (action === 'Initialise') {
            vscode.commands.executeCommand('bormagi.initialiseWorkspace');
          }
        });
      }
    }, 800);
  }
}

export async function deactivate(): Promise<void> {
  if (mcpHost) {
    await mcpHost.stopAll();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function initialiseWorkspace(
  workspaceRoot: string,
  cm: ConfigManager,
  gm: GitignoreManager
): Promise<void> {
  await cm.ensureBormagiDir();
  await gm.ensureBormagiIgnored();

  const existing = await cm.readProjectConfig();
  if (!existing) {
    const folderName = path.basename(workspaceRoot);
    const config: ProjectConfig = {
      project: { name: folderName, created_at: new Date().toISOString() },
      agents: []
    };
    await cm.writeProjectConfig(config);
  }

  vscode.window.showInformationMessage(
    'Bormagi workspace initialised. Run "Bormagi: Install Predefined Agents" to add the built-in agent set.'
  );
}

async function installPredefinedAgents(
  extensionPath: string,
  cm: ConfigManager,
  am: AgentManager
): Promise<void> {
  await cm.ensureBormagiDir();

  const predefinedDir = path.join(extensionPath, 'predefined-agents');
  const agentFolders = [
    'solution-architect',
    'data-architect',
    'business-analyst',
    'cloud-architect',
    'software-qa',
    'frontend-designer',
    'advanced-coder',
    'security-engineer',
    'devops-engineer',
    'technical-writer',
    'ai-engineer'
  ];

  const picked = await vscode.window.showQuickPick(
    agentFolders.map(id => ({
      label: id,
      description: 'Predefined agent',
      picked: true
    })),
    { canPickMany: true, title: 'Select agents to install' }
  );

  if (!picked || picked.length === 0) {
    return;
  }

  let installed = 0;
  for (const item of picked) {
    const agentId = item.label;
    const srcDir = path.join(predefinedDir, agentId);
    await am.installFromDirectory(srcDir, agentId);
    installed++;
  }

  await am.loadAgents();
  vscode.window.showInformationMessage(
    `Bormagi: Installed ${installed} predefined agent(s). Open the Chat to begin.`
  );
}

async function selectAgentCommand(am: AgentManager, cc: ChatController): Promise<void> {
  const agents = am.listAgents();
  if (agents.length === 0) {
    vscode.window.showWarningMessage(
      'Bormagi: No agents configured. Run "Bormagi: Install Predefined Agents" or create a new agent.'
    );
    return;
  }

  const items = agents.map(a => ({
    label: `@${a.id}`,
    description: a.name,
    detail: a.category
  }));

  const selection = await vscode.window.showQuickPick(items, {
    title: 'Select Active Agent',
    placeHolder: 'Choose the agent to activate'
  });

  if (selection) {
    const agentId = selection.label.replace('@', '');
    await cc.setActiveAgent(agentId);
  }
}
