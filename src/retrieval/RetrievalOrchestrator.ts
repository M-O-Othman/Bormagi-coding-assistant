// ─── Retrieval Orchestrator ───────────────────────────────────────────────────
//
// Gathers `ContextCandidate` items from multiple signals and returns a ranked
// list ready for the `ContextEnvelope` builder.
//
// Signals gathered (in priority order):
//   1. Active file / editor selection (always included)
//   2. Diagnostic files — stack trace, failing test names
//   3. Lexical search over the repo map
//   4. Import-graph neighbours of the active + diagnostic files
//   5. Recently edited files (from session memory)
//   6. Semantic / vector search (existing `RetrievalService`)
//   7. Repo-map slices for impacted directories
//
// Each candidate is then scored by `CandidateRanker` and pruned to fit the
// mode's `retrievedContext` budget slot.
//
// Spec reference: §FR-5.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AssistantMode, ContextCandidate, RepoMap, RetrievalQuery } from '../context/types';
import { estimateTokens } from '../context/BudgetEngine';
import { searchRepoMap, importGraphNeighbors } from './LexicalSearch';
import { rankAndPrune, scoreCandidate, type ScoringInput } from './CandidateRanker';
import { boundedWindow, extractSnippet } from './SnippetExtractor';
import { RetrievalService } from '../knowledge/RetrievalService';

// ─── Configuration ────────────────────────────────────────────────────────────

function getMaxCandidates(): number {
  return vscode.workspace.getConfiguration('bormagi.contextPipeline')
    .get<number>('retrieval.maxCandidatesBeforeRank', 60);
}

// ─── Candidate factory helpers ────────────────────────────────────────────────

let _nextId = 0;
function nextId(): string {
  return `rc-${++_nextId}`;
}

function makeSnippetCandidate(
  filePath: string,           // absolute path
  relativePath: string,       // repo-root relative
  anchorLine: number,
  editable: boolean,
  score: number,
  reasons: string[],
  snippetChars = 1600,
): ContextCandidate | null {
  const win = boundedWindow(anchorLine, 9999, 20, 40);
  const snippet = extractSnippet(filePath, win, snippetChars);
  if (!snippet) { return null; }

  return {
    id:            nextId(),
    kind:          'snippet',
    path:          relativePath,
    content:       snippet.content,
    tokenEstimate: estimateTokens(snippet.content),
    score,
    reasons,
    editable,
  };
}

function makeFileCandidate(
  relativePath: string,
  content: string,
  score: number,
  reasons: string[],
  editable: boolean,
): ContextCandidate {
  return {
    id:            nextId(),
    kind:          'file',
    path:          relativePath,
    content,
    tokenEstimate: estimateTokens(content),
    score,
    reasons,
    editable,
  };
}

// ─── Stack trace / test name → file path extraction ──────────────────────────

const STACK_FILE_RE = /(?:at\s+\S+\s+\(|^\s+at\s+)(.+?\.(?:ts|tsx|js|jsx|py|java))(?::\d+)*/gm;
const TEST_NAME_WORD_RE = /\b([A-Z][a-zA-Z0-9_]+|[a-z][a-zA-Z0-9_]{2,})\b/g;

function extractStackPaths(stackTrace: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(STACK_FILE_RE.source, 'gm');
  while ((match = re.exec(stackTrace)) !== null) {
    if (match[1]) { paths.push(match[1]); }
  }
  return [...new Set(paths)];
}

function stackPathToRelative(stackPath: string, workspaceRoot: string): string | null {
  // Paths in stack traces are usually absolute.
  if (path.isAbsolute(stackPath)) {
    return path.relative(workspaceRoot, stackPath).replace(/\\/g, '/');
  }
  return stackPath.replace(/\\/g, '/');
}

// ─── Core orchestration ───────────────────────────────────────────────────────

export interface OrchestratorOptions {
  workspaceRoot:       string;
  repoMap:             RepoMap | null;
  /** Paths recently edited in this session (relative to workspace root). */
  recentEditedFiles?:  string[];
  /** VS Code's currently active document path (absolute). */
  activeFilePath?:     string;
  /**
   * Optional semantic retrieval service.  When provided, vector search is run
   * in parallel with lexical search.
   */
  retrievalService?:   RetrievalService;
  agentId?:            string;
}

/**
 * Gather, score, and rank context candidates for a retrieval query.
 *
 * @param query    Structured description of the user request.
 * @param opts     Runtime context (workspace root, repo map, recent edits, etc.)
 * @param budgetTokens  Maximum tokens for the `retrievedContext` slot.
 * @returns        Ranked array of `ContextCandidate` within the token budget.
 */
export async function retrieveCandidates(
  query: RetrievalQuery,
  opts: OrchestratorOptions,
  budgetTokens: number,
): Promise<ContextCandidate[]> {
  const all: ContextCandidate[]     = [];
  const scoringInputs: ScoringInput[] = [];

  const { workspaceRoot, repoMap, recentEditedFiles = [], activeFilePath } = opts;

  // ── Signal 1: Active file ─────────────────────────────────────────────────

  if (activeFilePath && fs.existsSync(activeFilePath)) {
    const relPath = path.relative(workspaceRoot, activeFilePath).replace(/\\/g, '/');
    try {
      const content = fs.readFileSync(activeFilePath, 'utf8');
      const truncated = content.length > 8000 ? `${content.slice(0, 7985)}\n…[truncated]` : content;
      const c = makeFileCandidate(relPath, truncated, 0, ['active-file'], true);
      all.push(c);
      scoringInputs.push({ candidate: c, isActiveFile: true, isProductionCode: !relPath.includes('.test.') });
    } catch { /* skip */ }
  }

  // ── Signal 2: Diagnostic files (stack trace, failing tests) ──────────────

  const diagnosticPaths = new Set<string>();

  if (query.stackTrace) {
    for (const sp of extractStackPaths(query.stackTrace)) {
      const rel = stackPathToRelative(sp, workspaceRoot);
      if (rel) { diagnosticPaths.add(rel); }
    }
  }
  if (query.failingTestNames && repoMap) {
    // Heuristic: test file name often matches the test suite name.
    for (const testName of query.failingTestNames) {
      const words = testName.match(TEST_NAME_WORD_RE) ?? [];
      const matches = searchRepoMap(repoMap, words.join(' '), 5);
      for (const m of matches) {
        if (m.entry.flags.test) { diagnosticPaths.add(m.entry.path); }
      }
    }
  }

  for (const relPath of diagnosticPaths) {
    if (all.some(c => c.path === relPath)) { continue; }
    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) { continue; }
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const truncated = content.length > 6000 ? `${content.slice(0, 5985)}\n…[truncated]` : content;
      const c = makeFileCandidate(relPath, truncated, 0, ['diagnostic-hit'], false);
      all.push(c);
      scoringInputs.push({ candidate: c, isDiagnosticHit: true });
    } catch { /* skip */ }
  }

  // ── Signal 3: Lexical search over repo map ────────────────────────────────

  if (repoMap) {
    const lexMatches = searchRepoMap(repoMap, query.text, getMaxCandidates());
    const maxLexical = 30; // cap before ranking

    for (const match of lexMatches.slice(0, maxLexical)) {
      const relPath = match.entry.path;
      if (all.some(c => c.path === relPath)) { continue; }

      const absPath = path.join(workspaceRoot, relPath);
      if (!fs.existsSync(absPath)) { continue; }

      // Pick the best snippet anchor: highest-scoring symbol, or top of file.
      const anchor = bestSymbolAnchor(match.entry, match.matchedTerms) ?? 0;
      const win    = boundedWindow(anchor, match.entry.lineCount, 20, 40);
      const snippet = extractSnippet(absPath, win, 1600);
      if (!snippet) { continue; }

      const c: ContextCandidate = {
        id:            nextId(),
        kind:          'snippet',
        path:          relPath,
        content:       snippet.content,
        tokenEstimate: estimateTokens(snippet.content),
        score:         0, // will be set by scoreCandidate below
        reasons:       match.matchReasons,
        editable:      false,
      };

      all.push(c);
      const normLexScore = Math.min(1, match.score / 50); // normalise to 0–1
      scoringInputs.push({
        candidate:       c,
        lexicalScore:    normLexScore,
        isProductionCode: !match.entry.flags.test && !match.entry.flags.generated,
      });
    }
  }

  // ── Signal 4: Import-graph neighbours ────────────────────────────────────

  if (repoMap) {
    const seedPaths: string[] = [
      ...(query.activeFile ? [query.activeFile.replace(/\\/g, '/')] : []),
      ...Array.from(diagnosticPaths),
    ];

    const neighbors = importGraphNeighbors(repoMap, seedPaths, 1);
    for (const entry of neighbors) {
      if (all.some(c => c.path === entry.path)) { continue; }

      const absPath = path.join(workspaceRoot, entry.path);
      if (!fs.existsSync(absPath)) { continue; }

      const snippet = extractSnippet(absPath, boundedWindow(0, entry.lineCount, 0, 50), 1200);
      if (!snippet) { continue; }

      const c: ContextCandidate = {
        id:            nextId(),
        kind:          'snippet',
        path:          entry.path,
        content:       snippet.content,
        tokenEstimate: estimateTokens(snippet.content),
        score:         0,
        reasons:       ['import-neighbor'],
        editable:      false,
      };

      all.push(c);
      scoringInputs.push({ candidate: c, isImportNeighbor: true });
    }
  }

  // ── Signal 5: Recently edited files ──────────────────────────────────────

  for (const relPath of recentEditedFiles.slice(0, 10)) {
    if (all.some(c => c.path === relPath)) { continue; }
    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) { continue; }
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const truncated = content.length > 3000 ? `${content.slice(0, 2985)}\n…[truncated]` : content;
      const c = makeFileCandidate(relPath, truncated, 0, ['recent-edit'], false);
      all.push(c);
      scoringInputs.push({ candidate: c, isRecentEdit: true });
    } catch { /* skip */ }
  }

  // ── Signal 6: Semantic / vector search ───────────────────────────────────

  if (opts.retrievalService) {
    try {
      const evidence = await opts.retrievalService.retrieve(
        opts.agentId ?? 'context-agent',
        query.text,
        10,
      );
      for (const chunk of evidence.chunks) {
        const relPath = chunk.metadata.filename;
        if (all.some(c => c.path === relPath)) { continue; }

        const c: ContextCandidate = {
          id:            nextId(),
          kind:          'snippet',
          path:          relPath,
          content:       chunk.content,
          tokenEstimate: estimateTokens(chunk.content),
          score:         0,
          reasons:       ['semantic-search'],
          editable:      false,
        };

        all.push(c);
        scoringInputs.push({ candidate: c, semanticScore: chunk.score });
      }
    } catch { /* vector store not available — skip gracefully */ }
  }

  // ── Score all candidates ──────────────────────────────────────────────────

  for (const input of scoringInputs) {
    const raw = scoreCandidate(input);
    // Guard against NaN (e.g., in test environments where weight config returns undefined).
    input.candidate.score = isFinite(raw) && raw > 0 ? raw : 0.001;
  }

  // ── Rank and prune to budget ──────────────────────────────────────────────

  return rankAndPrune(all, budgetTokens, query.mode);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Find the first symbol whose name matches one of `matchedTerms`.
 * Falls back to 0 (top of file) when no match is found.
 */
function bestSymbolAnchor(
  entry: { symbols: Array<{ name: string; lineStart?: number }> },
  matchedTerms: string[],
): number | null {
  const termsLower = matchedTerms.map(t => t.toLowerCase());
  for (const sym of entry.symbols) {
    if (termsLower.some(t => sym.name.toLowerCase().includes(t))) {
      return sym.lineStart ?? 0;
    }
  }
  return null;
}
