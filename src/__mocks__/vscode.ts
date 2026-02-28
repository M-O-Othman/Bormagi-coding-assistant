// ─── VS Code mock for Jest tests ─────────────────────────────────────────────
//
// Provides minimal vscode API stubs so workflow tests can run outside VS Code.
// Real filesystem operations are used so e2e and recovery tests work correctly.

import * as fs from 'fs';
import * as nodePath from 'path';

// ─── Uri ─────────────────────────────────────────────────────────────────────

export const Uri = {
  file: (p: string) => ({
    fsPath: p,
    toString: () => `file://${p}`,
    scheme: 'file',
    path: p,
  }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => {
    const joined = nodePath.join(base.fsPath, ...parts);
    return { fsPath: joined, toString: () => `file://${joined}`, scheme: 'file', path: joined };
  },
};

// ─── FileType ────────────────────────────────────────────────────────────────

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

// ─── workspace.fs (real filesystem backed) ───────────────────────────────────

export const workspace = {
  fs: {
    stat: async (uri: { fsPath: string }) => {
      const s = fs.statSync(uri.fsPath); // throws ENOENT → caught by callers
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: 0, mtime: 0 };
    },
    createDirectory: async (uri: { fsPath: string }) => {
      fs.mkdirSync(uri.fsPath, { recursive: true });
    },
    readDirectory: async (uri: { fsPath: string }): Promise<[string, number][]> => {
      const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
      return entries.map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
    },
    readFile: async (uri: { fsPath: string }): Promise<Uint8Array> => {
      return new Uint8Array(fs.readFileSync(uri.fsPath));
    },
    writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
      fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
      fs.writeFileSync(uri.fsPath, Buffer.from(content));
    },
    delete: async (uri: { fsPath: string }, _options?: { recursive?: boolean }) => {
      fs.rmSync(uri.fsPath, { recursive: true, force: true });
    },
  },
  workspaceFolders: undefined as undefined,
  getConfiguration: () => ({ get: () => undefined }),
};

// ─── window ──────────────────────────────────────────────────────────────────

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  createWebviewPanel: () => ({}),
};

// ─── commands ────────────────────────────────────────────────────────────────

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose: () => {} }),
};

// ─── EventEmitter ────────────────────────────────────────────────────────────

export class EventEmitter<T = void> {
  private _listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
  };
  fire = (event: T) => { this._listeners.forEach(l => l(event)); };
  dispose = () => { this._listeners = []; };
}

// ─── ExtensionContext stub ────────────────────────────────────────────────────

export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const languages = { getDiagnostics: () => [] };
export const extensions = { getExtension: () => undefined };
