// ─── Lexical Search ───────────────────────────────────────────────────────────
//
// Term-based search over a `RepoMap`.  Scores and ranks `FileMapEntry` items
// based on how well their path, exports, symbol names, and summaries match a
// set of query terms.
//
// This is intentionally fast (no embeddings, no I/O) and runs entirely in
// memory over the already-built map.
//
// Spec reference: §FR-5 (lexical signal).

import type { FileMapEntry, RepoMap } from '../context/types';
import { extractQueryTerms } from '../agents/execution/PromptEfficiency';

// ─── Scoring weights ──────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  /** Query term appears in the file path (directory or filename). */
  pathMatch:      12,
  /** Query term matches a top-level exported name. */
  exportMatch:    10,
  /** Query term matches a symbol name. */
  symbolMatch:     8,
  /** Query term matches an import specifier. */
  importMatch:     4,
  /** Query term appears in the file summary (if available). */
  summaryMatch:    6,
  /** Bonus applied once when the file is NOT a test or generated file. */
  productionBonus: 3,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LexicalMatch {
  entry:          FileMapEntry;
  score:          number;
  matchedTerms:   string[];
  matchReasons:   string[];
}

// ─── Core search ──────────────────────────────────────────────────────────────

/**
 * Score a single `FileMapEntry` against the provided `terms`.
 * Returns `null` when no term matches at all.
 */
function scoreEntry(entry: FileMapEntry, terms: string[]): LexicalMatch | null {
  if (terms.length === 0) { return null; }

  const pathLower    = entry.path.toLowerCase();
  const matched      = new Set<string>();
  const reasons: string[] = [];
  let score = 0;

  for (const term of terms) {
    let termHit = false;

    // Path match
    if (pathLower.includes(term)) {
      score += SCORE_WEIGHTS.pathMatch;
      reasons.push(`path:${term}`);
      termHit = true;
    }

    // Export name match
    const exportHits = entry.exports.filter(e => e.toLowerCase().includes(term));
    if (exportHits.length > 0) {
      score += SCORE_WEIGHTS.exportMatch * Math.min(exportHits.length, 3);
      reasons.push(`export:${exportHits[0]}`);
      termHit = true;
    }

    // Symbol name match
    const symbolHits = entry.symbols.filter(s => s.name.toLowerCase().includes(term));
    if (symbolHits.length > 0) {
      score += SCORE_WEIGHTS.symbolMatch * Math.min(symbolHits.length, 3);
      reasons.push(`symbol:${symbolHits[0].name}`);
      termHit = true;
    }

    // Import match (useful for finding files that use a particular module)
    const importHits = entry.imports.filter(i => i.toLowerCase().includes(term));
    if (importHits.length > 0) {
      score += SCORE_WEIGHTS.importMatch;
      reasons.push(`import:${importHits[0]}`);
      termHit = true;
    }

    // Summary match
    if (entry.summary && entry.summary.toLowerCase().includes(term)) {
      score += SCORE_WEIGHTS.summaryMatch;
      reasons.push(`summary:${term}`);
      termHit = true;
    }

    if (termHit) { matched.add(term); }
  }

  if (score <= 0) { return null; }

  // Bonus for production (non-test, non-generated) files.
  if (!entry.flags.test && !entry.flags.generated) {
    score += SCORE_WEIGHTS.productionBonus;
  }

  return { entry, score, matchedTerms: Array.from(matched), matchReasons: reasons };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search the repo map for files relevant to `queryText`.
 *
 * @param repoMap    The in-memory repo map to search.
 * @param queryText  Raw user query string (will be tokenised internally).
 * @param topK       Maximum number of results to return. Default 20.
 * @returns          Array of `LexicalMatch` sorted by score descending.
 */
export function searchRepoMap(
  repoMap: RepoMap,
  queryText: string,
  topK = 20,
): LexicalMatch[] {
  const terms = extractQueryTerms(queryText);
  if (terms.length === 0) { return []; }

  const scored: LexicalMatch[] = [];
  for (const entry of repoMap.entries) {
    const match = scoreEntry(entry, terms);
    if (match) { scored.push(match); }
  }

  // Sort by score descending, break ties alphabetically.
  scored.sort((a, b) => {
    if (b.score !== a.score) { return b.score - a.score; }
    return a.entry.path.localeCompare(b.entry.path);
  });

  return scored.slice(0, topK);
}

/**
 * Search for files that are neighbours (share imports/exports) of `filePaths`.
 *
 * Used to expand the context envelope to files that are directly linked via
 * the module graph, even when they did not match lexically.
 *
 * @param repoMap    The in-memory repo map.
 * @param filePaths  Seed file paths (forward-slash normalised relative paths).
 * @param maxHops    Number of import-graph hops to follow. Default 1.
 * @returns          `FileMapEntry` items found within `maxHops` of the seeds.
 */
export function importGraphNeighbors(
  repoMap: RepoMap,
  filePaths: ReadonlyArray<string>,
  maxHops = 1,
): FileMapEntry[] {
  const byPath = new Map<string, FileMapEntry>(repoMap.entries.map(e => [e.path, e]));
  const visited = new Set<string>(filePaths);
  const result: FileMapEntry[] = [];
  let frontier = [...filePaths];

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier: string[] = [];

    for (const seedPath of frontier) {
      const seedEntry = byPath.get(seedPath);
      if (!seedEntry) { continue; }

      for (const imp of seedEntry.imports) {
        // Only follow relative imports (start with '.' or '..').
        if (!imp.startsWith('.')) { continue; }

        // Resolve the import relative to the seed's directory.
        const seedDir = seedPath.includes('/')
          ? seedPath.slice(0, seedPath.lastIndexOf('/'))
          : '';
        const candidates = resolveImport(imp, seedDir);

        for (const candidate of candidates) {
          if (visited.has(candidate)) { continue; }
          const entry = byPath.get(candidate);
          if (entry) {
            visited.add(candidate);
            result.push(entry);
            nextFrontier.push(candidate);
          }
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) { break; }
  }

  return result;
}

// ─── Import resolution helper ─────────────────────────────────────────────────

/**
 * Produce candidate repo-map paths for an import specifier relative to a
 * directory.  This is a heuristic (no full TS resolver), but covers the
 * common cases: `.ts`, `.tsx`, `.js`, `/index.ts`, etc.
 */
function resolveImport(importSpecifier: string, baseDir: string): string[] {
  // Build a raw joined path (forward-slash normalised).
  const raw = baseDir ? `${baseDir}/${importSpecifier}` : importSpecifier;

  // Normalise `./` and `../` segments manually (path.normalize uses OS separator).
  const parts = raw.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') { continue; }
    if (part === '..') { resolved.pop(); }
    else { resolved.push(part); }
  }
  const base = resolved.join('/');

  const candidates: string[] = [];
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

  // Already has an extension?
  if (/\.\w+$/.test(importSpecifier)) {
    candidates.push(base);
    return candidates;
  }

  // Try adding each extension.
  for (const ext of extensions) {
    candidates.push(`${base}${ext}`);
  }
  // Try index files.
  for (const ext of extensions) {
    candidates.push(`${base}/index${ext}`);
  }

  return candidates;
}
