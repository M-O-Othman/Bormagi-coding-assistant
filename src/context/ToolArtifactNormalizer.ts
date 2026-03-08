// ─── Tool Artifact Normalizer ─────────────────────────────────────────────────
//
// Converts raw tool output strings into structured, token-bounded artefacts
// that the PromptAssembler can include efficiently.
//
// Spec reference: §FR-11.

import type { TestFailureArtifact, SearchHitArtifact } from './types';
import { estimateTokens } from './BudgetEngine';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TEST_FAILURE_CHARS  = 2400;
const MAX_SEARCH_HIT_CHARS    =  600;
const MAX_BUILD_OUTPUT_CHARS  = 1600;
const MAX_DIFF_CHARS          = 3200;

// ─── Test failure normalizer ──────────────────────────────────────────────────

// Patterns for common test runners.
const JEST_FAIL_RE   = /●\s+(.+)/g;
const JEST_FILE_RE   = /(?:FAIL|RUNS)\s+([\w./\\-]+\.(?:test|spec)\.[tj]sx?)/g;
const PYTEST_FAIL_RE = /^FAILED (.+?) - (.+)$/gm;
const JUNIT_FAIL_RE  = /<failure[^>]*message="([^"]+)"/g;
const STACK_LINE_RE  = /^\s+at .+$/gm;

function extractJestFailures(raw: string): Array<{ testName: string; message: string }> {
  const failures: Array<{ testName: string; message: string }> = [];
  let m: RegExpExecArray | null;

  const fileRe = new RegExp(JEST_FAIL_RE.source, 'g');
  const failRe = new RegExp(JEST_FAIL_RE.source, 'g');

  while ((m = failRe.exec(raw)) !== null) {
    const name    = m[1].trim();
    const start   = m.index + m[0].length;
    // Grab up to 300 chars of context following the test name as the message.
    const context = raw.slice(start, start + 300).replace(/\n\s+/g, ' ').trim();
    failures.push({ testName: name, message: context.slice(0, 200) });
  }

  return failures;
}

function extractFailingFiles(raw: string): string[] {
  const files = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(JEST_FILE_RE.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    if (m[1]) { files.add(m[1]); }
  }

  // Also pick out stack-trace file refs like "at Object.<...> (src/foo.ts:12:3)".
  const traceRe = /\(([\w./\\-]+\.(?:ts|tsx|js|jsx)):\d+:\d+\)/g;
  while ((m = traceRe.exec(raw)) !== null) {
    if (m[1]) { files.add(m[1]); }
  }

  return Array.from(files);
}

/**
 * Parse raw test-runner output into a structured `TestFailureArtifact`.
 */
export function normalizeTestFailure(rawOutput: string): TestFailureArtifact {
  const failures = extractJestFailures(rawOutput);
  const failingFiles = extractFailingFiles(rawOutput);

  // Keep a bounded excerpt of the raw output.
  const truncated = rawOutput.length > MAX_TEST_FAILURE_CHARS
    ? `${rawOutput.slice(0, MAX_TEST_FAILURE_CHARS - 20)}\n…[truncated]`
    : rawOutput;

  // Extract a compact stack trace (first 10 stack lines).
  const stackLines = (rawOutput.match(STACK_LINE_RE) ?? []).slice(0, 10);

  return {
    failures,
    failingFiles,
    rawExcerpt: truncated,
    stackTrace: stackLines.join('\n'),
    tokenEstimate: estimateTokens(truncated),
  };
}

// ─── Search hit normalizer ────────────────────────────────────────────────────

const GREP_LINE_RE = /^(.+?):(\d+):(.*)$/gm;

/**
 * Parse grep/ripgrep-style output into `SearchHitArtifact[]`.
 * Each line of the form `file:line:content` becomes one hit.
 */
export function normalizeSearchHits(rawOutput: string): SearchHitArtifact[] {
  const hits: SearchHitArtifact[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(GREP_LINE_RE.source, 'gm');

  while ((m = re.exec(rawOutput)) !== null) {
    const [, filePath, lineStr, content] = m;
    if (!filePath || !lineStr) { continue; }

    const snippet = (content ?? '').trim().slice(0, MAX_SEARCH_HIT_CHARS);
    hits.push({
      filePath,
      line: parseInt(lineStr, 10),
      snippet,
      tokenEstimate: estimateTokens(snippet),
    });
  }

  return hits;
}

// ─── Build output normalizer ──────────────────────────────────────────────────

// Key lines to always preserve from build output.
const BUILD_KEY_PATTERNS = [
  /error\s+TS\d+/i,
  /error:/i,
  /warning:/i,
  /^\s*\d+\s+error/im,
  /^\s*\d+\s+warning/im,
  /Build succeeded/i,
  /Build failed/i,
];

/**
 * Reduce raw build output to the most actionable lines.
 *
 * Strategy: collect all lines matching key patterns first, then fill the
 * remaining token budget from the tail of the output (where errors usually are).
 */
export function normalizeBuildOutput(rawOutput: string): string {
  const lines   = rawOutput.split('\n');
  const keyLines = lines.filter(l => BUILD_KEY_PATTERNS.some(re => re.test(l)));

  const tail    = lines.slice(-60).join('\n');
  const full    = [...new Set([...keyLines, ...tail.split('\n')])].join('\n');

  if (full.length <= MAX_BUILD_OUTPUT_CHARS) { return full; }
  return `${full.slice(0, MAX_BUILD_OUTPUT_CHARS - 20)}\n…[truncated]`;
}

// ─── Diff normalizer ──────────────────────────────────────────────────────────

/**
 * Bound a unified diff to `MAX_DIFF_CHARS`, preserving file headers and
 * hunk headers so the model always sees which files are changed.
 */
export function normalizeDiff(rawDiff: string): string {
  if (rawDiff.length <= MAX_DIFF_CHARS) { return rawDiff; }

  const lines = rawDiff.split('\n');
  const kept: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    // Always keep file header and hunk header lines.
    const isHeader = line.startsWith('---') || line.startsWith('+++') ||
                     line.startsWith('diff ') || line.startsWith('@@');
    if (isHeader || charCount + line.length + 1 <= MAX_DIFF_CHARS) {
      kept.push(line);
      charCount += line.length + 1;
    } else {
      kept.push('…[lines omitted]');
      break;
    }
  }

  return kept.join('\n');
}

// ─── Generic truncation ───────────────────────────────────────────────────────

/**
 * Truncate any string to `maxChars`, appending an ellipsis marker.
 */
export function truncateOutput(text: string, maxChars = MAX_BUILD_OUTPUT_CHARS): string {
  if (text.length <= maxChars) { return text; }
  return `${text.slice(0, maxChars - 20)}\n…[truncated]`;
}
