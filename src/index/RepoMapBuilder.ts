// ─── Repo Map Builder ─────────────────────────────────────────────────────────
//
// Walks the workspace, filters files with IgnoreRules, extracts symbols via
// SymbolExtractor, and produces a `RepoMap` JSON structure stored on disk.
//
// Designed for background execution so the UI is never blocked.
//
// Spec reference: §FR-2.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { FileMapEntry, RepoMap } from '../context/types';
import {
  shouldExclude,
  detectLanguage,
  isSymbolIndexable,
} from './IgnoreRules';
import { extractSymbolsFromUri, extractImports, extractExports } from './SymbolExtractor';

// ─── Build options ────────────────────────────────────────────────────────────

export interface RepoMapBuildOptions {
  /** Maximum number of files to index (safeguard for huge repos). Default 2000. */
  maxFiles?: number;
  /** Maximum file size in bytes to read for symbol extraction. Default 200 KB. */
  maxFileSizeBytes?: number;
  /** User-provided explicit include paths (bypass ignore rules). */
  userIncludes?: string[];
  /** Path to `.bormagi/config/allowlist.json` (optional). */
  allowlistFile?: string;
  /** Path to `.bormagi/config/.bormagiignore` (optional). */
  ignoreFile?: string;
  /** Called with progress 0–100 during the build. */
  onProgress?: (pct: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RepoMapBuildOptions, 'onProgress' | 'userIncludes' | 'allowlistFile' | 'ignoreFile'>> = {
  maxFiles:        2000,
  maxFileSizeBytes: 200_000,
};

// ─── File walking ─────────────────────────────────────────────────────────────

/**
 * Recursively list all files under `dirPath`, honouring `shouldExclude`.
 * Stops at `maxFiles` to avoid hanging on enormous repos.
 */
function walkDirectory(
  dirPath: string,
  workspaceRoot: string,
  opts: Required<Omit<RepoMapBuildOptions, 'onProgress'>>,
  results: string[],
): void {
  if (results.length >= opts.maxFiles) { return; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= opts.maxFiles) { break; }

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(workspaceRoot, fullPath);

    if (shouldExclude(relativePath, opts.userIncludes, opts.allowlistFile, opts.ignoreFile)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDirectory(fullPath, workspaceRoot, opts, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
}

// ─── Single-file entry builder ────────────────────────────────────────────────

async function buildFileEntry(
  fullPath: string,
  relativePath: string,
  opts: { maxFileSizeBytes: number },
): Promise<FileMapEntry | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }

  const language   = detectLanguage(relativePath);
  const byteSize   = stat.size;
  const lineCount  = byteSize === 0 ? 0 : countLines(fullPath, opts.maxFileSizeBytes);
  const lastModifiedUtc = stat.mtime.toISOString();

  const flags = {
    generated: /\bgenerated\b|\.g\.|\.gen\./i.test(relativePath),
    test:      /\.(test|spec)\.[tj]sx?$|__tests__/.test(relativePath),
    config:    /\.(config|rc)\.[tj]sx?$|\.eslintrc|tsconfig|webpack\.config/i.test(relativePath),
    vendored:  /\bvendor\b/.test(relativePath),
    binary:    byteSize > opts.maxFileSizeBytes,
  };

  // Skip symbol extraction for binary / generated / oversized files.
  const canIndex = isSymbolIndexable(language) && !flags.binary && !flags.generated;

  let symbols: FileMapEntry['symbols'] = [];
  let imports: string[] = [];
  let exports: string[] = [];
  let content = '';

  if (!flags.binary && byteSize <= opts.maxFileSizeBytes) {
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      return null;
    }

    imports = extractImports(content);
    exports = extractExports(content);
  }

  if (canIndex) {
    try {
      const uri = vscode.Uri.file(fullPath);
      symbols = await extractSymbolsFromUri(uri);
    } catch {
      // Language server may not be ready — continue with empty symbols.
      symbols = [];
    }
  }

  return {
    path: relativePath.replace(/\\/g, '/'),
    language,
    exports,
    imports,
    symbols,
    lineCount,
    byteSize,
    lastModifiedUtc,
    flags,
  };
}

function countLines(filePath: string, maxBytes: number): number {
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, 1_000_000));
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let count = 1;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0a) { count++; }
    }
    return count;
  } catch {
    return 0;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a `RepoMap` for `workspaceRoot` by indexing all eligible files.
 *
 * Runs asynchronously; heavy I/O is done with synchronous `fs` calls that are
 * quick per-file — the async boundary is only at symbol extraction (VS Code
 * language-server calls).
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @param options        Tuning options (max files, size limits, progress cb).
 * @returns              The completed `RepoMap`.
 */
export async function buildRepoMap(
  workspaceRoot: string,
  options: RepoMapBuildOptions = {},
): Promise<RepoMap> {
  const opts = {
    maxFiles:         options.maxFiles         ?? DEFAULT_OPTIONS.maxFiles,
    maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_OPTIONS.maxFileSizeBytes,
    userIncludes:     options.userIncludes     ?? [],
    allowlistFile:    options.allowlistFile,
    ignoreFile:       options.ignoreFile,
  };

  // 1. Walk the directory tree.
  const filePaths: string[] = [];
  walkDirectory(workspaceRoot, workspaceRoot, opts, filePaths);

  const entries: FileMapEntry[] = [];
  const total = filePaths.length;

  // 2. Build an entry per file.
  for (let i = 0; i < filePaths.length; i++) {
    const fullPath   = filePaths[i];
    const relativePath = path.relative(workspaceRoot, fullPath);
    const entry = await buildFileEntry(fullPath, relativePath, opts);
    if (entry) { entries.push(entry); }

    if (options.onProgress && total > 0) {
      options.onProgress(Math.round(((i + 1) / total) * 100));
    }
  }

  return {
    repoRoot:         workspaceRoot.replace(/\\/g, '/'),
    generatedAtUtc:   new Date().toISOString(),
    entries,
  };
}

/**
 * Incrementally update an existing `RepoMap` by rebuilding only the entries
 * whose file modification time has changed.
 *
 * Files that no longer exist are removed.  New files (not in the map) are
 * added.
 *
 * @param existing      The previously built `RepoMap`.
 * @param workspaceRoot Absolute path to the workspace root.
 * @param options       Same options as `buildRepoMap`.
 */
export async function incrementalUpdateRepoMap(
  existing: RepoMap,
  workspaceRoot: string,
  options: RepoMapBuildOptions = {},
): Promise<RepoMap> {
  const opts = {
    maxFiles:         options.maxFiles         ?? DEFAULT_OPTIONS.maxFiles,
    maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_OPTIONS.maxFileSizeBytes,
    userIncludes:     options.userIncludes     ?? [],
    allowlistFile:    options.allowlistFile,
    ignoreFile:       options.ignoreFile,
  };

  // Index existing entries by path for fast lookup.
  const existingByPath = new Map<string, FileMapEntry>(
    existing.entries.map(e => [e.path, e]),
  );

  // Walk current workspace files.
  const filePaths: string[] = [];
  walkDirectory(workspaceRoot, workspaceRoot, opts, filePaths);

  const updatedEntries: FileMapEntry[] = [];
  const seenPaths = new Set<string>();

  for (const fullPath of filePaths) {
    const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
    seenPaths.add(relativePath);

    const existing = existingByPath.get(relativePath);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(fullPath); } catch { continue; }

    const currentMtime = stat.mtime.toISOString();
    if (existing && existing.lastModifiedUtc === currentMtime) {
      // File unchanged — reuse existing entry.
      updatedEntries.push(existing);
    } else {
      // New or modified — rebuild entry.
      const entry = await buildFileEntry(fullPath, relativePath, opts);
      if (entry) { updatedEntries.push(entry); }
    }
  }

  // Files removed from disk are simply not included (seenPaths filter).
  return {
    repoRoot:         workspaceRoot.replace(/\\/g, '/'),
    generatedAtUtc:   new Date().toISOString(),
    entries:          updatedEntries,
  };
}
