import * as vscode from 'vscode';
import * as path from 'path';

const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cs', '.cpp', '.c', '.h',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.r', '.m',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.sql',
  '.csv', '.tsv', '.doc', '.docx', '.pdf'
]);

const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.bormagi',
  'out', 'target', 'bin', 'obj', '.venv', 'venv', 'env'
];

export interface ScannedFile {
  relativePath: string;
  content: string;
}

export class FileScanner {
  constructor(private readonly workspaceRoot: string) {}

  async scanWorkspace(
    includeExtensions = DEFAULT_INCLUDE_EXTENSIONS,
    excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
    maxFiles = 50,
    maxFileSizeKb = 100
  ): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    await this.walk(
      this.workspaceRoot,
      this.workspaceRoot,
      includeExtensions,
      new Set(excludePatterns),
      maxFiles,
      maxFileSizeKb,
      results
    );
    return results;
  }

  private async walk(
    dir: string,
    root: string,
    includeExt: Set<string>,
    excludeDirs: Set<string>,
    maxFiles: number,
    maxFileSizeKb: number,
    results: ScannedFile[]
  ): Promise<void> {
    if (results.length >= maxFiles) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (results.length >= maxFiles) {
        break;
      }

      if (type === vscode.FileType.Directory) {
        if (!excludeDirs.has(name) && !name.startsWith('.')) {
          await this.walk(
            path.join(dir, name),
            root,
            includeExt,
            excludeDirs,
            maxFiles,
            maxFileSizeKb,
            results
          );
        }
      } else if (type === vscode.FileType.File) {
        const ext = path.extname(name).toLowerCase();
        if (!includeExt.has(ext)) {
          continue;
        }

        const fullPath = path.join(dir, name);
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
          if (stat.size > maxFileSizeKb * 1024) {
            continue;
          }
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
          const content = Buffer.from(raw).toString('utf8');
          const relativePath = path.relative(root, fullPath);
          results.push({ relativePath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }
}
