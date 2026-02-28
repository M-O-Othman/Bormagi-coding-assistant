import * as vscode from 'vscode';
import * as path from 'path';

const BORMAGI_ENTRY = '.bormagi/';

export class GitignoreManager {
  constructor(private readonly workspaceRoot: string) {}

  async ensureBormagiIgnored(): Promise<void> {
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    const uri = vscode.Uri.file(gitignorePath);

    let content = '';
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      content = Buffer.from(raw).toString('utf8');
    } catch {
      // .gitignore does not exist yet — will create it
    }

    if (!content.includes(BORMAGI_ENTRY) && !content.includes('.bormagi')) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      const addition = `${separator}\n# Bormagi agent configuration (local workspace only)\n${BORMAGI_ENTRY}\n`;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content + addition, 'utf8'));
    }
  }
}
