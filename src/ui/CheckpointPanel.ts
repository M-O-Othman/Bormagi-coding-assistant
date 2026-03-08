import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CheckpointManager } from '../git/CheckpointManager';

export class CheckpointPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'bormagi.checkpointHistory';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly checkpointManager: CheckpointManager
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'restore':
                    try {
                        await this.checkpointManager.restoreCheckpoint(data.checkpointId);
                        vscode.window.showInformationMessage(`Restored to checkpoint ${data.checkpointId}`);
                        this.refresh();
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Restore failed: ${err.message}`);
                    }
                    break;
                case 'refresh':
                    this.refresh();
                    break;
            }
        });

        this.refresh();
    }

    public async refresh() {
        if (!this._view) return;
        const history = await this.checkpointManager.getHistory();
        this._view.webview.postMessage({ type: 'history', history });
    }

    private getHtmlForWebview(webview: vscode.Webview) {
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'checkpoint.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Basic CSP and resource path mapping
        html = html.replace(/\$\{webview\.cspSource\}/g, webview.cspSource);
        return html;
    }
}
