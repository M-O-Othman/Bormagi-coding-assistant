import * as vscode from 'vscode';

export interface TemplateContext {
  workspace: string;
  date: string;
  filename: string;
  selection: string;
  agent_name: string;
  project_name: string;
}

export class TemplateEngine {
  static resolve(template: string, context: Partial<TemplateContext>): string {
    let result = template;
    for (const [key, value] of Object.entries(context)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value ?? '');
    }
    return result;
  }

  static buildContext(agentName: string, projectName: string): TemplateContext {
    const editor = vscode.window.activeTextEditor;
    const filename = editor?.document.fileName ?? '';
    const selection = editor?.document.getText(editor.selection) ?? '';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspace = workspaceFolders?.[0]?.name ?? '';

    return {
      workspace,
      date: new Date().toISOString().split('T')[0],
      filename,
      selection,
      agent_name: agentName,
      project_name: projectName
    };
  }
}
