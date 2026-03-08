// ─── Repo Map Store ───────────────────────────────────────────────────────────
//
// Persists and loads the `RepoMap` JSON to/from
// `.bormagi/repo-map.json` in the workspace root.
//
// Responsibilities:
//   - Save a complete `RepoMap` to disk.
//   - Load the existing map at session start (returns null if absent/corrupt).
//   - Check whether a specific `FileMapEntry` is still fresh (mtime match).
//   - Serialize a token-bounded slice of the map for prompt injection.
//
// Spec reference: §FR-2.

import * as fs from 'fs';
import * as path from 'path';
import type { FileMapEntry, RepoMap, SymbolEntry } from '../context/types';
import { estimateTokens } from '../context/BudgetEngine';

// ─── Store location ───────────────────────────────────────────────────────────

const REPO_MAP_FILENAME = 'repo-map.json';

function repoMapPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.bormagi', REPO_MAP_FILENAME);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist a `RepoMap` to `.bormagi/repo-map.json`.
 * The `.bormagi/` directory is created if it does not exist.
 */
export function saveRepoMap(workspaceRoot: string, repoMap: RepoMap): void {
  const filePath = repoMapPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(repoMap, null, 2), 'utf8');
}

/**
 * Load the persisted `RepoMap` from `.bormagi/repo-map.json`.
 * Returns `null` when the file does not exist or cannot be parsed.
 */
export function loadRepoMap(workspaceRoot: string): RepoMap | null {
  const filePath = repoMapPath(workspaceRoot);
  if (!fs.existsSync(filePath)) { return null; }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as RepoMap;
  } catch {
    return null;
  }
}

// ─── Freshness check ──────────────────────────────────────────────────────────

/**
 * Return `true` when the on-disk file at `absolutePath` has the same mtime
 * as recorded in `entry.lastModifiedUtc`.
 *
 * Used by the incremental update path to decide which entries need rebuilding.
 */
export function isFresh(entry: FileMapEntry, absolutePath: string): boolean {
  if (!entry.lastModifiedUtc) { return false; }
  try {
    const stat = fs.statSync(absolutePath);
    return stat.mtime.toISOString() === entry.lastModifiedUtc;
  } catch {
    return false;
  }
}

// ─── Token-bounded serialisation ──────────────────────────────────────────────

/**
 * Options for `serializeRepoMapSlice`.
 */
export interface SliceOptions {
  /**
   * Maximum total tokens the output string may consume.
   * Uses the same 4-chars-per-token heuristic as `BudgetEngine`.
   */
  maxTokens: number;
  /**
   * When `true`, include symbol-level detail (names + signatures).
   * When `false`, emit only file paths and top-level metadata.
   * Default `true`.
   */
  includeSymbols?: boolean;
  /**
   * When provided, only include files whose path starts with one of these
   * directory prefixes (forward-slash normalised).
   */
  filterPaths?: string[];
}

/**
 * Produce a compact, human-readable text representation of the repo map that
 * fits within `options.maxTokens`.
 *
 * Files are prioritised by symbol count (most symbols first) so the most
 * information-dense entries survive the token budget cut.
 *
 * The output format is plain text — not JSON — since it is intended for direct
 * injection into a model prompt.
 */
export function serializeRepoMapSlice(repoMap: RepoMap, options: SliceOptions): string {
  const { maxTokens, includeSymbols = true, filterPaths } = options;

  // Filter to requested path prefixes.
  let entries = filterPaths
    ? repoMap.entries.filter(e =>
        filterPaths.some(prefix => e.path.startsWith(prefix)),
      )
    : [...repoMap.entries];

  // Sort: most symbols first, then alphabetically.
  entries.sort((a, b) => {
    const diff = b.symbols.length - a.symbols.length;
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
  });

  const lines: string[] = [
    `[Repo Map — ${repoMap.entries.length} files, generated ${repoMap.generatedAtUtc}]`,
    '',
  ];
  let tokenCount = estimateTokens(lines.join('\n'));

  for (const entry of entries) {
    const entryLines = formatEntry(entry, includeSymbols);
    const chunk = entryLines.join('\n') + '\n';
    const chunkTokens = estimateTokens(chunk);

    if (tokenCount + chunkTokens > maxTokens) {
      // Try falling back to path-only representation.
      const fallback = `${entry.path}\n`;
      const fallbackTokens = estimateTokens(fallback);
      if (tokenCount + fallbackTokens > maxTokens) {
        break; // No more room.
      }
      lines.push(entry.path);
      tokenCount += fallbackTokens;
    } else {
      lines.push(...entryLines);
      tokenCount += chunkTokens;
    }
  }

  return lines.join('\n');
}

// ─── Internal format helpers ──────────────────────────────────────────────────

function formatEntry(entry: FileMapEntry, includeSymbols: boolean): string[] {
  const flagStr = buildFlagStr(entry);
  const header = `${entry.path} [${entry.language}, ${entry.lineCount} lines${flagStr}]`;
  const lines: string[] = [header];

  if (includeSymbols && entry.symbols.length > 0) {
    for (const sym of entry.symbols) {
      lines.push(`  ${sym.kind} ${sym.name}${sym.signature ? ` — ${compactSignature(sym.signature)}` : ''}`);
    }
  } else if (entry.exports.length > 0) {
    lines.push(`  exports: ${entry.exports.slice(0, 10).join(', ')}`);
  }

  return lines;
}

function buildFlagStr(entry: FileMapEntry): string {
  const parts: string[] = [];
  if (entry.flags.test)      { parts.push('test'); }
  if (entry.flags.config)    { parts.push('config'); }
  if (entry.flags.generated) { parts.push('generated'); }
  if (entry.flags.vendored)  { parts.push('vendored'); }
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
}

function compactSignature(sig: string): string {
  // Trim leading whitespace and collapse internal whitespace runs.
  const compact = sig.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
