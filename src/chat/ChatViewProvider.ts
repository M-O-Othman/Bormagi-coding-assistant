import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatController, MessageToWebview } from './ChatController';
import { getAppData } from '../data/DataStore';
import { getMarkedFallbackSource } from './markedFallback';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Subscribe so controller can post messages to the webview
    this.controller.addSubscriber((msg: MessageToWebview) => {
      webviewView.webview.postMessage(msg);
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
      const type = message.type as string;
      if (type === 'user_message' && message.text) {
        await this.controller.handleUserMessage(message.text as string);
      } else if (type === 'refresh_agents') {
        await this.controller.refreshAgentList();
      } else if (type === 'select_agent' && message.agentId) {
        await this.controller.setActiveAgent(message.agentId as string);
      } else if (type === 'switch_model') {
        await this.controller.handleWebviewMessage(message);
      } else if (type === 'set_mode') {
        await this.controller.handleWebviewMessage(message);
      } else if (type === 'restore_checkpoint') {
        await this.controller.handleWebviewMessage(message);
      } else if (type === 'open_dashboard') {
        await vscode.commands.executeCommand('bormagi.openDashboard');
      } else if (type === 'open_meeting') {
        await vscode.commands.executeCommand('bormagi.startMeeting');
      } else if (type === 'open_agent_settings') {
        await vscode.commands.executeCommand('bormagi.openSettings');
      } else if (type === 'action_response' && message.id) {
        this.controller.resolveAction(message.id as string, message.value as string | undefined);
      } else if (type === 'stop_agent') {
        this.controller.stopCurrentRun();
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    const nonce = getNonce();

    const chatCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
    );
    const chatJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );

    try {
      let raw = fs.readFileSync(htmlPath, 'utf8');

      // Replace CSP source and nonce placeholders
      raw = raw.replaceAll('{{CSP_SOURCE}}', webview.cspSource);
      raw = raw.replaceAll('{{NONCE}}', nonce);

      // Replace resource URIs
      raw = raw.replace('{{CHAT_CSS_URI}}', chatCssUri.toString());
      raw = raw.replace('{{CHAT_JS_URI}}', chatJsUri.toString());

      // Inject model context limits
      raw = raw.replace(
        '{{MODEL_CONTEXT_LIMITS_JSON}}',
        JSON.stringify(getAppData().contextLimits)
      );

      // Inject marked.js library
      let markedInjected = false;
      try {
        const candidatePaths = [
          path.join(this.extensionUri.fsPath, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
          path.join(this.extensionUri.fsPath, 'media', 'vendor', 'marked.umd.js')
        ];
        for (const markedPath of candidatePaths) {
          if (fs.existsSync(markedPath)) {
            // Strip sourceMappingURL to avoid a blocked CSP request for the .map file
            const markedSrc = fs.readFileSync(markedPath, 'utf8')
              .replace(/\/\/# sourceMappingURL=\S+/g, '');
            raw = raw.replace('/*__MARKED_LIB__*/', markedSrc);
            markedInjected = true;
            break;
          }
        }
      } catch {
        // Intentionally swallow
      }
      if (!markedInjected) {
        raw = raw.replace('/*__MARKED_LIB__*/', getMarkedFallbackSource());
      }

      return raw;
    } catch {
      return '<html><body><p>Bormagi: Could not load chat UI.</p></body></html>';
    }
  }
}
