/**
 * Built-in MCP code-navigation server (stdio transport).
 *
 * Provides structured, budget-friendly alternatives to whole-file reads and
 * recursive directory listings:
 *   - glob_files      — fast path-pattern discovery
 *   - grep_content    — regex/literal content search with context lines
 *   - read_file_range — read a specific line range
 *   - read_head       — first N lines
 *   - read_tail       — last N lines
 *   - read_match_context — expand around a grep hit
 *
 * All outputs are structured JSON so the execution engine can consume them
 * without parsing prose. All paths in outputs are posix-relative to the
 * workspace root.
 *
 * Restricts all operations to the workspace root supplied as the first CLI argument.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
// fast-glob is a transitive dependency (via chokidar / globby) — no explicit dep needed
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fastGlob: typeof import('fast-glob') = require('fast-glob');

const workspaceRoot = process.argv[2] ?? process.cwd();

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────────

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

// ─── Path safety ──────────────────────────────────────────────────────────────

const BLOCKED_DIR_NAMES = ['.bormagi', '.git', 'node_modules', 'dist', 'build'];

/**
 * Resolves path and verifies it stays inside workspaceRoot.
 * Throws if the path escapes the workspace.
 */
function resolveSafe(filePath: string): string {
  const resolved = path.resolve(workspaceRoot, filePath);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Access denied: path is outside the workspace.');
  }
  return resolved;
}

/**
 * Returns true if the relative path targets a blocked directory.
 * Applies to .bormagi, .git, node_modules, dist, build.
 */
function isBlockedPath(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return BLOCKED_DIR_NAMES.some(
    d => normalised === d || normalised.startsWith(d + '/')
  );
}

/** Convert an absolute path to a posix-style relative path from workspaceRoot. */
function toRelativePosix(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
}

/** Standard blocked result. */
function blockedResult(toolName: string): object {
  return {
    status: 'blocked',
    toolName,
    summary: 'Access to this path is not permitted.',
    blockedReason: 'Path is inside a blocked directory (.bormagi, .git, node_modules, dist, build).',
  };
}

// ─── Default excludes ─────────────────────────────────────────────────────────

const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.bormagi/**',
];

// ─── Tool: glob_files ─────────────────────────────────────────────────────────

interface GlobFilesArgs {
  pattern: string;
  exclude?: string[];
  max_results?: number;
  include_directories?: boolean;
}

function globFiles(args: GlobFilesArgs): object {
  const maxResults = Math.min(Math.max(args.max_results ?? 200, 1), 10000);
  const includeDirectories = args.include_directories ?? false;
  const allExcludes = [...DEFAULT_EXCLUDES, ...(args.exclude ?? [])];

  let entries: import('fast-glob').Entry[];
  try {
    entries = fastGlob.sync(args.pattern, {
      cwd: workspaceRoot,
      ignore: allExcludes,
      absolute: false,
      onlyFiles: !includeDirectories,
      stats: true,
      dot: false,
    }) as import('fast-glob').Entry[];
  } catch (err) {
    return { status: 'error', toolName: 'glob_files', summary: String(err) };
  }

  const truncated = entries.length > maxResults;
  const limited = entries.slice(0, maxResults);

  const matches = limited.map((e: any) => ({
    path: (typeof e === 'string' ? e : e.path ?? e).replace(/\\/g, '/'),
    type: (e.dirent?.isDirectory?.() ? 'dir' : 'file') as string,
    size_bytes: (e.stats?.size ?? 0) as number,
    mtime: (e.stats?.mtime?.toISOString?.() ?? '') as string,
  }));

  return {
    status: 'success',
    toolName: 'glob_files',
    summary: `Found ${entries.length} file(s) matching "${args.pattern}"${truncated ? ' (truncated)' : ''}.`,
    payload: { matches, truncated, total_matches: entries.length },
  };
}

// ─── Tool: grep_content ───────────────────────────────────────────────────────

interface GrepContentArgs {
  pattern: string;
  mode?: 'literal' | 'regex';
  include?: string[];
  exclude?: string[];
  case_sensitive?: boolean;
  context_lines?: number;
  max_results?: number;
}

function grepContent(args: GrepContentArgs): object {
  const maxResults = Math.min(Math.max(args.max_results ?? 100, 1), 1000);
  const contextLines = Math.min(Math.max(args.context_lines ?? 0, 0), 20);
  const caseSensitive = args.case_sensitive ?? false;
  const searchMode = args.mode ?? 'literal';
  const includes = args.include ?? ['**/*'];
  const allExcludes = [...DEFAULT_EXCLUDES, ...(args.exclude ?? [])];

  // Build search regex
  let regex: RegExp;
  try {
    const patternStr = searchMode === 'literal'
      ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : args.pattern;
    regex = new RegExp(patternStr, caseSensitive ? '' : 'i');
  } catch (err) {
    return { status: 'error', toolName: 'grep_content', summary: `Invalid pattern: ${err}` };
  }

  // Find candidate files
  let filePaths: string[];
  try {
    filePaths = fastGlob.sync(includes, {
      cwd: workspaceRoot,
      ignore: allExcludes,
      absolute: true,
      onlyFiles: true,
      dot: false,
    }) as string[];
  } catch (err) {
    return { status: 'error', toolName: 'grep_content', summary: String(err) };
  }

  const matches: object[] = [];
  let totalMatches = 0;
  let truncated = false;

  outer: for (const filePath of filePaths) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = regex.exec(line);
      if (!match) continue;

      totalMatches++;
      if (matches.length >= maxResults) {
        truncated = true;
        break outer;
      }

      const before = contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : [];
      const after = contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines) : [];

      matches.push({
        path: toRelativePosix(filePath),
        line: i + 1,
        column: match.index + 1,
        match_text: match[0],
        line_text: line,
        before,
        after,
      });
    }
  }

  return {
    status: 'success',
    toolName: 'grep_content',
    summary: `Found ${totalMatches} match(es)${truncated ? ` (showing first ${maxResults})` : ''}.`,
    payload: { matches, truncated, total_matches: totalMatches },
  };
}

// ─── Tool: read_file_range ────────────────────────────────────────────────────

interface ReadFileRangeArgs {
  path: string;
  start_line: number;
  end_line: number;
  include_line_numbers?: boolean;
}

function readFileRange(args: ReadFileRangeArgs): object {
  if (isBlockedPath(args.path)) { return blockedResult('read_file_range'); }
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'read_file_range', summary: String(err) }; }

  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'read_file_range', summary: String(err) }; }

  const allLines = content.split('\n');
  const startLine = Math.max(1, args.start_line);
  // Hard cap: 1000 lines per read
  const endLine = Math.min(Math.min(args.end_line, startLine + 999), allLines.length);
  const truncated = args.end_line > endLine;
  const includeLineNumbers = args.include_line_numbers !== false;

  const slice = allLines.slice(startLine - 1, endLine);
  const resultContent = includeLineNumbers
    ? slice.map((text, i) => ({ line: startLine + i, text }))
    : slice.map(text => ({ text }));

  return {
    status: 'success',
    toolName: 'read_file_range',
    summary: `Read lines ${startLine}–${endLine} of ${args.path}${truncated ? ' (truncated at 1000 lines)' : ''}.`,
    payload: { path: args.path, start_line: startLine, end_line: endLine, content: resultContent, truncated },
  };
}

// ─── Tool: read_head ──────────────────────────────────────────────────────────

interface ReadHeadArgs { path: string; lines?: number; }

function readHead(args: ReadHeadArgs): object {
  if (isBlockedPath(args.path)) { return blockedResult('read_head'); }
  const n = Math.min(Math.max(args.lines ?? 80, 1), 500);
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'read_head', summary: String(err) }; }

  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'read_head', summary: String(err) }; }

  const allLines = content.split('\n');
  const slice = allLines.slice(0, n);

  return {
    status: 'success',
    toolName: 'read_head',
    summary: `Read first ${slice.length} lines of ${args.path}.`,
    payload: {
      path: args.path,
      start_line: 1,
      end_line: slice.length,
      content: slice.map((text, i) => ({ line: i + 1, text })),
      truncated: allLines.length > n,
      total_lines: allLines.length,
    },
  };
}

// ─── Tool: read_tail ──────────────────────────────────────────────────────────

interface ReadTailArgs { path: string; lines?: number; }

function readTail(args: ReadTailArgs): object {
  if (isBlockedPath(args.path)) { return blockedResult('read_tail'); }
  const n = Math.min(Math.max(args.lines ?? 80, 1), 500);
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'read_tail', summary: String(err) }; }

  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'read_tail', summary: String(err) }; }

  const allLines = content.split('\n');
  const start = Math.max(0, allLines.length - n);
  const slice = allLines.slice(start);

  return {
    status: 'success',
    toolName: 'read_tail',
    summary: `Read last ${slice.length} lines of ${args.path}.`,
    payload: {
      path: args.path,
      start_line: start + 1,
      end_line: allLines.length,
      content: slice.map((text, i) => ({ line: start + 1 + i, text })),
      truncated: false,
      total_lines: allLines.length,
    },
  };
}

// ─── Tool: read_match_context ─────────────────────────────────────────────────

interface ReadMatchContextArgs {
  path: string;
  line: number;
  before?: number;
  after?: number;
}

function readMatchContext(args: ReadMatchContextArgs): object {
  if (isBlockedPath(args.path)) { return blockedResult('read_match_context'); }
  const beforeLines = Math.min(Math.max(args.before ?? 20, 0), 100);
  const afterLines = Math.min(Math.max(args.after ?? 20, 0), 100);
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'read_match_context', summary: String(err) }; }

  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'read_match_context', summary: String(err) }; }

  const allLines = content.split('\n');
  const matchLine = Math.max(1, Math.min(args.line, allLines.length));
  const startLine = Math.max(1, matchLine - beforeLines);
  const endLine = Math.min(allLines.length, matchLine + afterLines);
  const slice = allLines.slice(startLine - 1, endLine);

  return {
    status: 'success',
    toolName: 'read_match_context',
    summary: `Read ${slice.length} lines around line ${matchLine} of ${args.path}.`,
    payload: {
      path: args.path,
      match_line: matchLine,
      start_line: startLine,
      end_line: endLine,
      content: slice.map((text, i) => ({
        line: startLine + i,
        text,
        is_match: startLine + i === matchLine,
      })),
    },
  };
}

// ─── Phase 2: Edit tools ──────────────────────────────────────────────────────

/**
 * Backup-and-restore atomicity helper for multi_edit.
 * Copies each target file to <file>.bormagi-bak before any writes.
 * On commit: deletes backups. On rollback: restores all backups.
 */
class EditTransaction {
  private backups = new Map<string, string>(); // absPath → backupPath

  /** Back up a file. Must be called before any write to that file. */
  prepare(absPath: string): void {
    if (this.backups.has(absPath)) return; // already backed up
    const backupPath = absPath + '.bormagi-bak';
    try {
      fs.copyFileSync(absPath, backupPath);
    } catch {
      // File doesn't exist yet — nothing to back up
    }
    this.backups.set(absPath, backupPath);
  }

  /** Remove all backups after a successful transaction. */
  commit(): void {
    for (const backupPath of this.backups.values()) {
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    this.backups.clear();
  }

  /**
   * Restore all backed-up files and delete backups.
   * Returns a list of any files that failed to restore.
   */
  rollback(): string[] {
    const failures: string[] = [];
    for (const [absPath, backupPath] of this.backups) {
      try {
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, absPath);
          fs.unlinkSync(backupPath);
        } else {
          // Backup doesn't exist — file was new; delete the partial write
          try { fs.unlinkSync(absPath); } catch { /* best effort */ }
        }
      } catch (err) {
        failures.push(`${absPath}: ${err}`);
      }
    }
    this.backups.clear();
    return failures;
  }
}

/** Generate a compact diff summary string for a single file edit. */
function diffSummary(filePath: string, startLine: number, endLine: number, replacement: string): string {
  const removedLines = endLine - startLine + 1;
  const addedLines = replacement.split('\n').length;
  return `${filePath}: lines ${startLine}–${endLine} (${removedLines} removed, ${addedLines} added)`;
}

// ─── Tool: replace_range ──────────────────────────────────────────────────────

interface ReplaceRangeArgs {
  path: string;
  start_line: number;
  end_line: number;
  replacement: string;
  create_backup?: boolean;
  preview_only?: boolean;
}

function replaceRange(args: ReplaceRangeArgs): object {
  if (isBlockedPath(args.path)) { return blockedResult('replace_range'); }
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'replace_range', summary: String(err) }; }

  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'replace_range', summary: `Cannot read file: ${err}` }; }

  const lines = content.split('\n');
  const startLine = Math.max(1, args.start_line);
  const endLine = Math.min(args.end_line, lines.length);

  if (startLine > endLine) {
    return { status: 'error', toolName: 'replace_range', summary: `start_line (${startLine}) must be <= end_line (${endLine}).` };
  }

  const before = lines.slice(startLine - 1, endLine);
  const replacementLines = args.replacement.split('\n');
  const newLines = [
    ...lines.slice(0, startLine - 1),
    ...replacementLines,
    ...lines.slice(endLine),
  ];
  const newContent = newLines.join('\n');

  const preview = {
    before_snippet: before.map((t, i) => `- ${startLine + i}: ${t}`).join('\n'),
    after_snippet: replacementLines.map((t, i) => `+ ${startLine + i}: ${t}`).join('\n'),
    diff_summary: diffSummary(args.path, startLine, endLine, args.replacement),
  };

  if (args.preview_only) {
    return {
      status: 'success',
      toolName: 'replace_range',
      summary: `[PREVIEW] ${preview.diff_summary}`,
      payload: { ...preview, applied: false },
    };
  }

  // Backup if requested
  if (args.create_backup) {
    try { fs.copyFileSync(safe, safe + '.bormagi-bak'); } catch { /* best effort */ }
  }

  try {
    fs.writeFileSync(safe, newContent, 'utf8');
  } catch (err) {
    return { status: 'error', toolName: 'replace_range', summary: `Write failed: ${err}` };
  }

  return {
    status: 'success',
    toolName: 'replace_range',
    summary: preview.diff_summary,
    payload: { ...preview, applied: true },
    touchedPaths: [args.path],
  };
}

// ─── Tool: multi_edit ─────────────────────────────────────────────────────────

interface EditSpec {
  path: string;
  start_line: number;
  end_line: number;
  replacement: string;
}

interface MultiEditArgs {
  edits: EditSpec[];
  preview_only?: boolean;
  atomic?: boolean;
}

function multiEdit(args: MultiEditArgs): object {
  const atomic = args.atomic !== false; // default true

  if (!args.edits || args.edits.length === 0) {
    return { status: 'error', toolName: 'multi_edit', summary: 'No edits provided.' };
  }
  if (args.edits.length > 50) {
    return { status: 'error', toolName: 'multi_edit', summary: 'Maximum 50 edits per call.' };
  }

  // Validate all edits first
  for (const edit of args.edits) {
    if (isBlockedPath(edit.path)) {
      return { status: 'blocked', toolName: 'multi_edit', summary: `Path blocked: ${edit.path}`, blockedReason: edit.path };
    }
    try { resolveSafe(edit.path); } catch (err) {
      return { status: 'error', toolName: 'multi_edit', summary: `Invalid path "${edit.path}": ${err}` };
    }
    if (edit.start_line > edit.end_line) {
      return { status: 'error', toolName: 'multi_edit', summary: `Edit for "${edit.path}": start_line (${edit.start_line}) must be <= end_line (${edit.end_line}).` };
    }
  }

  // Preview mode: apply all edits in-memory, return diff summary
  if (args.preview_only) {
    const diffs: string[] = [];
    // Group by file and sort descending to compute preview
    const byFile = new Map<string, EditSpec[]>();
    for (const edit of args.edits) {
      const key = edit.path.replace(/\\/g, '/');
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(edit);
    }
    for (const [, fileEdits] of byFile) {
      fileEdits.sort((a, b) => b.start_line - a.start_line);
      for (const edit of fileEdits) {
        diffs.push(diffSummary(edit.path, edit.start_line, edit.end_line, edit.replacement));
      }
    }
    return {
      status: 'success',
      toolName: 'multi_edit',
      summary: `[PREVIEW] ${diffs.length} edit(s) across ${byFile.size} file(s).`,
      payload: { applied: false, diff_summary: diffs },
    };
  }

  // Group edits by file; sort each group descending by start_line (no line-number drift)
  const byFile = new Map<string, EditSpec[]>();
  for (const edit of args.edits) {
    const key = edit.path.replace(/\\/g, '/');
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(edit);
  }
  for (const fileEdits of byFile.values()) {
    fileEdits.sort((a, b) => b.start_line - a.start_line);
  }

  const transaction = new EditTransaction();
  const touchedPaths: string[] = [];
  const diffs: string[] = [];

  // Backup phase (atomic only)
  if (atomic) {
    for (const filePath of byFile.keys()) {
      try {
        transaction.prepare(path.resolve(workspaceRoot, filePath));
      } catch (err) {
        return { status: 'error', toolName: 'multi_edit', summary: `Backup failed for "${filePath}": ${err}` };
      }
    }
  }

  // Apply phase
  for (const [filePath, fileEdits] of byFile) {
    const absPath = path.resolve(workspaceRoot, filePath);

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      if (atomic) {
        const rollbackFailures = transaction.rollback();
        return {
          status: 'error',
          toolName: 'multi_edit',
          summary: `Cannot read "${filePath}": ${err}. All changes rolled back.${rollbackFailures.length > 0 ? ` Rollback errors: ${rollbackFailures.join(', ')}` : ''}`,
        };
      }
      diffs.push(`${filePath}: FAILED (cannot read: ${err})`);
      continue;
    }

    let lines = content.split('\n');
    for (const edit of fileEdits) {
      const start = Math.max(1, edit.start_line);
      const end = Math.min(edit.end_line, lines.length);
      diffs.push(diffSummary(filePath, start, end, edit.replacement));
      lines = [
        ...lines.slice(0, start - 1),
        ...edit.replacement.split('\n'),
        ...lines.slice(end),
      ];
    }

    try {
      fs.writeFileSync(absPath, lines.join('\n'), 'utf8');
      touchedPaths.push(filePath);
    } catch (err) {
      if (atomic) {
        const rollbackFailures = transaction.rollback();
        return {
          status: 'error',
          toolName: 'multi_edit',
          summary: `Write failed for "${filePath}": ${err}. All changes rolled back.${rollbackFailures.length > 0 ? ` Rollback errors: ${rollbackFailures.join(', ')}` : ''}`,
        };
      }
      diffs.push(`${filePath}: FAILED (write error: ${err})`);
    }
  }

  if (atomic) {
    transaction.commit();
  }

  return {
    status: 'success',
    toolName: 'multi_edit',
    summary: `Applied ${touchedPaths.length} file(s), ${diffs.length} edit(s).`,
    payload: { applied: touchedPaths.length, files_changed: touchedPaths, diff_summary: diffs },
    touchedPaths,
  };
}

// ─── Symbol parsing engine ────────────────────────────────────────────────────

export type SymbolKind = 'class' | 'function' | 'method' | 'interface' | 'type' | 'const' | 'any';

export interface SymbolLocation {
  symbol: string;
  symbolKind: Exclude<SymbolKind, 'any'>;
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
  path: string;      // posix-relative to workspace root
}

/**
 * Symbol matchers for TypeScript / JavaScript / Python / Go etc.
 * Each matcher returns { name, kind, bodyStart } from a single line
 * where bodyStart indicates the line opens a block (`{` or `:`).
 * End-of-block is determined by brace/indent counting in findBlockEnd().
 */
const SYMBOL_PATTERNS: Array<{
  kind: Exclude<SymbolKind, 'any'>;
  re: RegExp;
}> = [
  { kind: 'class',     re: /^(?:export\s+(?:default\s+)?|abstract\s+)?class\s+(\w+)/ },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+(\w+)/ },
  { kind: 'type',      re: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/ },
  { kind: 'function',  re: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(\w+)\s*[(<]/ },
  { kind: 'const',     re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]*)?\s*=/ },
  // Arrow functions: export const foo = (...) =>
  { kind: 'function',  re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:<[^>]*>)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/ },
  // Method signatures inside a class: methodName( or async methodName( or private/public/protected methodName(
  { kind: 'method',    re: /^(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*(\w+)\s*[(<]/ },
  // Python def
  { kind: 'function',  re: /^(?:async\s+)?def\s+(\w+)\s*\(/ },
  // Python class
  { kind: 'class',     re: /^class\s+(\w+)\s*[:(]/ },
];

/**
 * Scan lines in a file and find all symbol declarations matching the query/kind filter.
 * Uses regex heuristics — works for TS/JS/TSX/JSX/Python/Go and similar.
 */
function parseSymbols(filePath: string, queryRe: RegExp | null, kind: SymbolKind): SymbolLocation[] {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = content.split('\n');
  const results: SymbolLocation[] = [];
  const relativePath = toRelativePosix(filePath);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    for (const { kind: k, re } of SYMBOL_PATTERNS) {
      if (kind !== 'any' && kind !== k) continue;
      const m = re.exec(trimmed);
      if (!m) continue;
      const name = m[1];
      if (!name || /^(if|for|while|switch|catch|return|new|typeof|instanceof)$/.test(name)) continue;
      if (queryRe && !queryRe.test(name)) continue;

      const endLine = findBlockEnd(lines, i);
      results.push({ symbol: name, symbolKind: k, startLine: i + 1, endLine, path: relativePath });
      break; // one match per line
    }
  }
  return results;
}

/**
 * Finds the closing line of a block starting at lineIndex (0-based).
 * Uses brace counting for `{`-terminated languages and indent counting for Python-style.
 * Returns the 1-based line number of the last line of the block.
 */
function findBlockEnd(lines: string[], startIndex: number): number {
  const startLine = lines[startIndex];
  const usesIndent = /^\s*(?:async\s+)?def\s+|^class\s+.*:$/.test(startLine) &&
                     !startLine.includes('{');

  if (usesIndent) {
    const baseIndent = startLine.length - startLine.trimStart().length;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const t = lines[i];
      if (t.trim() === '') continue;
      const indent = t.length - t.trimStart().length;
      if (indent <= baseIndent) return i; // line before this one ends the block
    }
    return lines.length;
  }

  // Brace counting
  let depth = 0;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
    }
    // Single-line arrow functions or type aliases that never opened a brace
    if (i === startIndex && depth === 0) return i + 1;
  }
  return lines.length;
}

// ─── Tool: find_symbols ───────────────────────────────────────────────────────

interface FindSymbolsArgs {
  query?: string;
  symbol_kind?: SymbolKind;
  include?: string[];
  max_results?: number;
}

async function findSymbols(args: FindSymbolsArgs): Promise<object> {
  const queryRe = args.query
    ? new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    : null;
  const kind: SymbolKind = args.symbol_kind ?? 'any';
  const includePatterns = args.include ?? ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
  const maxResults = Math.min(args.max_results ?? 20, 200);

  let files: string[];
  try {
    files = await fastGlob(includePatterns, {
      cwd: workspaceRoot,
      ignore: DEFAULT_EXCLUDES,
      absolute: true,
      onlyFiles: true,
    });
  } catch (err) {
    return { status: 'error', toolName: 'find_symbols', summary: `Glob failed: ${err}` };
  }

  const matches: SymbolLocation[] = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    const symbols = parseSymbols(file, queryRe, kind);
    for (const s of symbols) {
      matches.push(s);
      if (matches.length >= maxResults) break;
    }
  }

  return {
    status: 'success',
    toolName: 'find_symbols',
    summary: `Found ${matches.length} symbol(s) matching "${args.query ?? '*'}" (kind=${kind}) across ${files.length} file(s).`,
    payload: { matches, files_searched: files.length, truncated: matches.length >= maxResults },
  };
}

// ─── Tool: read_symbol_block ──────────────────────────────────────────────────

interface ReadSymbolBlockArgs {
  path: string;
  symbol: string;
  symbol_kind?: SymbolKind;
}

function readSymbolBlock(args: ReadSymbolBlockArgs): object {
  if (isBlockedPath(args.path)) return blockedResult('read_symbol_block');
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'read_symbol_block', summary: String(err) }; }

  const kind: SymbolKind = args.symbol_kind ?? 'any';
  const queryRe = new RegExp(`^${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const symbols = parseSymbols(safe, queryRe, kind);

  if (symbols.length === 0) {
    return { status: 'error', toolName: 'read_symbol_block', summary: `Symbol "${args.symbol}" not found in ${args.path}.` };
  }

  const loc = symbols[0];
  let content: string;
  try { content = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'read_symbol_block', summary: `Cannot read file: ${err}` }; }
  const lines = content.split('\n');
  const lineObjects = lines
    .slice(loc.startLine - 1, loc.endLine)
    .map((text, i) => ({ line: loc.startLine + i, text }));

  return {
    status: 'success',
    toolName: 'read_symbol_block',
    summary: `${loc.symbolKind} "${loc.symbol}" at lines ${loc.startLine}–${loc.endLine} in ${args.path}.`,
    payload: { location: loc, content: lineObjects },
  };
}

// ─── Tool: replace_symbol_block ───────────────────────────────────────────────

interface ReplaceSymbolBlockArgs {
  path: string;
  symbol: string;
  symbol_kind?: SymbolKind;
  replacement: string;
  preview_only?: boolean;
}

function replaceSymbolBlock(args: ReplaceSymbolBlockArgs): object {
  if (isBlockedPath(args.path)) return blockedResult('replace_symbol_block');
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'replace_symbol_block', summary: String(err) }; }

  const kind: SymbolKind = args.symbol_kind ?? 'any';
  const queryRe = new RegExp(`^${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const symbols = parseSymbols(safe, queryRe, kind);

  if (symbols.length === 0) {
    return { status: 'error', toolName: 'replace_symbol_block', summary: `Symbol "${args.symbol}" not found in ${args.path}.` };
  }

  const loc = symbols[0];
  return replaceRange({
    path: args.path,
    start_line: loc.startLine,
    end_line: loc.endLine,
    replacement: args.replacement,
    preview_only: args.preview_only ?? false,
  });
}

// ─── Tool: insert_before_symbol ───────────────────────────────────────────────

interface InsertNearSymbolArgs {
  path: string;
  symbol: string;
  symbol_kind?: SymbolKind;
  content: string;
  preview_only?: boolean;
}

function insertBeforeSymbol(args: InsertNearSymbolArgs): object {
  if (isBlockedPath(args.path)) return blockedResult('insert_before_symbol');
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'insert_before_symbol', summary: String(err) }; }

  const kind: SymbolKind = args.symbol_kind ?? 'any';
  const queryRe = new RegExp(`^${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const symbols = parseSymbols(safe, queryRe, kind);
  if (symbols.length === 0) {
    return { status: 'error', toolName: 'insert_before_symbol', summary: `Symbol "${args.symbol}" not found in ${args.path}.` };
  }

  const loc = symbols[0];
  const insertLine = Math.max(1, loc.startLine);

  let fileContent: string;
  try { fileContent = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'insert_before_symbol', summary: `Cannot read file: ${err}` }; }
  const lines = fileContent.split('\n');

  const newLines = [
    ...lines.slice(0, insertLine - 1),
    ...args.content.split('\n'),
    ...lines.slice(insertLine - 1),
  ];

  const preview = {
    insert_at: insertLine,
    before_symbol: loc.symbol,
    content_snippet: args.content.split('\n').slice(0, 3).join('\n'),
  };

  if (args.preview_only) {
    return { status: 'success', toolName: 'insert_before_symbol', summary: `[PREVIEW] Insert before ${loc.symbolKind} "${loc.symbol}" at line ${insertLine}.`, payload: { ...preview, applied: false } };
  }

  try { fs.writeFileSync(safe, newLines.join('\n'), 'utf8'); } catch (err) {
    return { status: 'error', toolName: 'insert_before_symbol', summary: `Write failed: ${err}` };
  }

  return {
    status: 'success',
    toolName: 'insert_before_symbol',
    summary: `Inserted ${args.content.split('\n').length} line(s) before ${loc.symbolKind} "${loc.symbol}" at line ${insertLine} in ${args.path}.`,
    payload: { ...preview, applied: true },
    touchedPaths: [args.path],
  };
}

// ─── Tool: insert_after_symbol ────────────────────────────────────────────────

function insertAfterSymbol(args: InsertNearSymbolArgs): object {
  if (isBlockedPath(args.path)) return blockedResult('insert_after_symbol');
  let safe: string;
  try { safe = resolveSafe(args.path); } catch (err) { return { status: 'error', toolName: 'insert_after_symbol', summary: String(err) }; }

  const kind: SymbolKind = args.symbol_kind ?? 'any';
  const queryRe = new RegExp(`^${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const symbols = parseSymbols(safe, queryRe, kind);
  if (symbols.length === 0) {
    return { status: 'error', toolName: 'insert_after_symbol', summary: `Symbol "${args.symbol}" not found in ${args.path}.` };
  }

  const loc = symbols[0];
  const insertLine = loc.endLine + 1;

  let fileContent: string;
  try { fileContent = fs.readFileSync(safe, 'utf8'); } catch (err) { return { status: 'error', toolName: 'insert_after_symbol', summary: `Cannot read file: ${err}` }; }
  const lines = fileContent.split('\n');

  const newLines = [
    ...lines.slice(0, insertLine - 1),
    ...args.content.split('\n'),
    ...lines.slice(insertLine - 1),
  ];

  const preview = {
    insert_at: insertLine,
    after_symbol: loc.symbol,
    content_snippet: args.content.split('\n').slice(0, 3).join('\n'),
  };

  if (args.preview_only) {
    return { status: 'success', toolName: 'insert_after_symbol', summary: `[PREVIEW] Insert after ${loc.symbolKind} "${loc.symbol}" at line ${insertLine}.`, payload: { ...preview, applied: false } };
  }

  try { fs.writeFileSync(safe, newLines.join('\n'), 'utf8'); } catch (err) {
    return { status: 'error', toolName: 'insert_after_symbol', summary: `Write failed: ${err}` };
  }

  return {
    status: 'success',
    toolName: 'insert_after_symbol',
    summary: `Inserted ${args.content.split('\n').length} line(s) after ${loc.symbolKind} "${loc.symbol}" at line ${loc.endLine} in ${args.path}.`,
    payload: { ...preview, applied: true },
    touchedPaths: [args.path],
  };
}

// ─── Tool registry ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'glob_files',
    description: 'Find files by path pattern. Use this BEFORE read_file or list_files — it is much cheaper and does not read file contents. Returns structured JSON with path, size, and modification time.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "**/package.json".' },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional glob patterns to exclude (node_modules/.git/dist/build/.bormagi always excluded by default).',
        },
        max_results: { type: 'integer', minimum: 1, maximum: 10000, default: 200, description: 'Maximum number of results to return.' },
        include_directories: { type: 'boolean', default: false, description: 'Include directories in results.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep_content',
    description: 'Search file contents by regex or literal pattern. Returns structured JSON with file path, line number, match text, and optional context lines. Prefer this over read_file for content discovery. Replaces search_files with richer output and better controls.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to search for.' },
        mode: { type: 'string', enum: ['literal', 'regex'], default: 'literal', description: '"literal" for exact text, "regex" for regular expressions.' },
        include: { type: 'array', items: { type: 'string' }, default: ['**/*'], description: 'Glob patterns for files to search.' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Glob patterns for files to skip.' },
        case_sensitive: { type: 'boolean', default: false },
        context_lines: { type: 'integer', minimum: 0, maximum: 20, default: 0, description: 'Lines before and after each match to include.' },
        max_results: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file_range',
    description: 'Read a specific line range from a file. Counts as a cheap targeted read (not a whole-file read). Use this instead of read_file when you know which lines you need.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to read (1-based, inclusive). Capped at start_line + 999.' },
        include_line_numbers: { type: 'boolean', default: true },
      },
      required: ['path', 'start_line', 'end_line'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_head',
    description: 'Read the first N lines of a file. Cheap targeted read. Use to inspect file structure, imports, or top-level declarations without reading the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        lines: { type: 'integer', minimum: 1, maximum: 500, default: 80, description: 'Number of lines from the start.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_tail',
    description: 'Read the last N lines of a file. Cheap targeted read. Use to inspect recent additions or file endings.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        lines: { type: 'integer', minimum: 1, maximum: 500, default: 80, description: 'Number of lines from the end.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_match_context',
    description: 'Read lines surrounding a specific line number in a file. Use after grep_content to expand around a match and understand its context.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer', minimum: 1, description: 'The line number to centre on (e.g. from a grep_content match).' },
        before: { type: 'integer', minimum: 0, maximum: 100, default: 20, description: 'Lines before the match line.' },
        after: { type: 'integer', minimum: 0, maximum: 100, default: 20, description: 'Lines after the match line.' },
      },
      required: ['path', 'line'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_range',
    description: 'Replace a specific line range in a file. Prefer this over write_file for targeted edits to existing files. Use preview_only=true first to verify the diff before applying. Requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to replace (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to replace (1-based, inclusive).' },
        replacement: { type: 'string', description: 'New content to insert in place of the replaced lines.' },
        create_backup: { type: 'boolean', default: false, description: 'Save a .bormagi-bak backup before writing.' },
        preview_only: { type: 'boolean', default: false, description: 'Return diff without writing. Use this to verify the change first.' },
      },
      required: ['path', 'start_line', 'end_line', 'replacement'],
      additionalProperties: false,
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply multiple targeted line-range replacements atomically across one or more files. All edits apply or none (atomic=true). Use preview_only=true to review the full diff first. Requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description: 'List of edits to apply.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              start_line: { type: 'integer', minimum: 1 },
              end_line: { type: 'integer', minimum: 1 },
              replacement: { type: 'string' },
            },
            required: ['path', 'start_line', 'end_line', 'replacement'],
            additionalProperties: false,
          },
        },
        preview_only: { type: 'boolean', default: false, description: 'Return diff summary without writing.' },
        atomic: { type: 'boolean', default: true, description: 'If true, all edits apply or none (backup-and-restore on failure). Recommended.' },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_symbols',
    description: 'Find symbol declarations (classes, functions, methods, interfaces, types, consts) across files by name query. Returns symbol name, kind, file path, and line range. Use this instead of grep_content when looking for specific named symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name to search for (partial match, case-insensitive). Omit to list all symbols.' },
        symbol_kind: { type: 'string', enum: ['any', 'class', 'function', 'method', 'interface', 'type', 'const'], default: 'any' },
        include: { type: 'array', items: { type: 'string' }, default: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'], description: 'File glob patterns to search.' },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_symbol_block',
    description: 'Read the full source of a named symbol (function, class, method, etc.) without reading the whole file. Counts as a targeted read. Use this instead of read_file_range when you know the symbol name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file.' },
        symbol: { type: 'string', description: 'Exact symbol name.' },
        symbol_kind: { type: 'string', enum: ['any', 'class', 'function', 'method', 'interface', 'type', 'const'], default: 'any' },
      },
      required: ['path', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_symbol_block',
    description: 'Replace the full body of a named symbol in a file. The framework auto-detects the symbol\'s start and end lines. Use preview_only=true to verify the diff first. Requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        symbol: { type: 'string', description: 'Exact symbol name to replace.' },
        symbol_kind: { type: 'string', enum: ['any', 'class', 'function', 'method', 'interface', 'type', 'const'], default: 'any' },
        replacement: { type: 'string', description: 'New source code to replace the symbol with.' },
        preview_only: { type: 'boolean', default: false },
      },
      required: ['path', 'symbol', 'replacement'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_before_symbol',
    description: 'Insert lines immediately before a named symbol. Useful for adding imports, helpers, or decorators. Use preview_only=true to verify first. Requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        symbol: { type: 'string' },
        symbol_kind: { type: 'string', enum: ['any', 'class', 'function', 'method', 'interface', 'type', 'const'], default: 'any' },
        content: { type: 'string', description: 'Code to insert before the symbol.' },
        preview_only: { type: 'boolean', default: false },
      },
      required: ['path', 'symbol', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_after_symbol',
    description: 'Insert lines immediately after a named symbol. Useful for adding overloads, companion functions, or appending to a module. Use preview_only=true to verify first. Requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        symbol: { type: 'string' },
        symbol_kind: { type: 'string', enum: ['any', 'class', 'function', 'method', 'interface', 'type', 'const'], default: 'any' },
        content: { type: 'string', description: 'Code to insert after the symbol.' },
        preview_only: { type: 'boolean', default: false },
      },
      required: ['path', 'symbol', 'content'],
      additionalProperties: false,
    },
  },
];

// ─── MCP protocol handler ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let req: { jsonrpc: string; id: number; method: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return;
  }

  const { id, method, params } = req;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'code-nav', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = (params as { name: string; arguments: Record<string, unknown> }).name;
      const args = (params as { name: string; arguments: Record<string, unknown> }).arguments;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = args as any;

      (async () => {
        let result: object;
        if (toolName === 'glob_files') result = globFiles(a as GlobFilesArgs);
        else if (toolName === 'grep_content') result = grepContent(a as GrepContentArgs);
        else if (toolName === 'read_file_range') result = readFileRange(a as ReadFileRangeArgs);
        else if (toolName === 'read_head') result = readHead(a as ReadHeadArgs);
        else if (toolName === 'read_tail') result = readTail(a as ReadTailArgs);
        else if (toolName === 'read_match_context') result = readMatchContext(a as ReadMatchContextArgs);
        else if (toolName === 'replace_range') result = replaceRange(a as ReplaceRangeArgs);
        else if (toolName === 'multi_edit') result = multiEdit(a as MultiEditArgs);
        else if (toolName === 'find_symbols') result = await findSymbols(a as FindSymbolsArgs);
        else if (toolName === 'read_symbol_block') result = readSymbolBlock(a as ReadSymbolBlockArgs);
        else if (toolName === 'replace_symbol_block') result = replaceSymbolBlock(a as ReplaceSymbolBlockArgs);
        else if (toolName === 'insert_before_symbol') result = insertBeforeSymbol(a as InsertNearSymbolArgs);
        else if (toolName === 'insert_after_symbol') result = insertAfterSymbol(a as InsertNearSymbolArgs);
        else throw new Error(`Unknown tool: ${toolName}`);

        respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      })().catch(err => respond(id, { content: [{ type: 'text', text: String(err) }], isError: true }));
      return; // async path handles the response
    } else {
      respondError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    respond(id, { content: [{ type: 'text', text: String(err) }], isError: true });
  }
});
