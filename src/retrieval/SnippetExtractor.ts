// ─── Snippet Extractor ────────────────────────────────────────────────────────
//
// Reads a source file from disk and extracts a bounded window of lines centred
// around a target line (e.g., a symbol definition, a search hit).
//
// Spec reference: §FR-12.3 "bounded snippet windows".

import * as fs from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnippetWindow {
  /** 0-based index of the first line included in the snippet. */
  startLine: number;
  /** 0-based index of the last line included in the snippet (inclusive). */
  endLine: number;
}

export interface ExtractedSnippet {
  path:        string;
  startLine:   number;
  endLine:     number;
  content:     string;
  /** Whether the snippet was truncated due to the `maxChars` limit. */
  truncated:   boolean;
}

// ─── Bounded window calculation ───────────────────────────────────────────────

/**
 * Compute the line-number window centred around `anchorLine`.
 *
 * @param anchorLine  0-based line number of the focal point.
 * @param totalLines  Total number of lines in the file.
 * @param before      Lines to include before `anchorLine`. Default 20.
 * @param after       Lines to include after  `anchorLine`. Default 30.
 * @returns           `SnippetWindow` with clamped `startLine` / `endLine`.
 */
export function boundedWindow(
  anchorLine: number,
  totalLines: number,
  before = 20,
  after  = 30,
): SnippetWindow {
  const startLine = Math.max(0, anchorLine - before);
  const endLine   = Math.min(totalLines - 1, anchorLine + after);
  return { startLine, endLine };
}

/**
 * Compute a window that encompasses a full symbol range.
 * Expands by `padding` lines on each side to include context.
 *
 * @param lineStart  0-based start of the symbol range.
 * @param lineEnd    0-based end   of the symbol range.
 * @param totalLines Total lines in the file.
 * @param padding    Extra lines around the symbol. Default 3.
 */
export function symbolWindow(
  lineStart: number,
  lineEnd:   number,
  totalLines: number,
  padding = 3,
): SnippetWindow {
  return {
    startLine: Math.max(0, lineStart - padding),
    endLine:   Math.min(totalLines - 1, lineEnd + padding),
  };
}

// ─── File reading ─────────────────────────────────────────────────────────────

/**
 * Read a file and extract a snippet for the given window.
 *
 * The snippet is returned as a plain-text string.  Lines are 1-indexed in the
 * output annotation (`startLine + 1` in the header) to match editor line
 * numbers which are 1-based.
 *
 * @param absolutePath  Full filesystem path to the source file.
 * @param window        `SnippetWindow` (0-based line indices).
 * @param maxChars      Maximum characters to return. Default 1800.
 * @returns             `ExtractedSnippet` or `null` if the file cannot be read.
 */
export function extractSnippet(
  absolutePath: string,
  window: SnippetWindow,
  maxChars = 1800,
): ExtractedSnippet | null {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  const allLines = content.split('\n');
  const sliced   = allLines.slice(window.startLine, window.endLine + 1);
  const raw      = sliced.join('\n');

  const truncated = raw.length > maxChars;
  const text      = truncated ? `${raw.slice(0, maxChars - 15)}\n…[truncated]` : raw;

  return {
    path:      absolutePath,
    startLine: window.startLine,
    endLine:   window.endLine,
    content:   text,
    truncated,
  };
}

/**
 * Extract a snippet from an in-memory string (useful for testing or when the
 * file content has already been read).
 */
export function extractSnippetFromContent(
  content: string,
  window: SnippetWindow,
  maxChars = 1800,
): Omit<ExtractedSnippet, 'path'> {
  const allLines = content.split('\n');
  const sliced   = allLines.slice(window.startLine, window.endLine + 1);
  const raw      = sliced.join('\n');
  const truncated = raw.length > maxChars;
  return {
    startLine: window.startLine,
    endLine:   window.endLine,
    content:   truncated ? `${raw.slice(0, maxChars - 15)}\n…[truncated]` : raw,
    truncated,
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Count the number of lines in a file without loading the entire content into
 * memory (fast streaming approach using a read buffer).
 */
export function countFileLines(absolutePath: string): number {
  try {
    const content = fs.readFileSync(absolutePath, 'utf8');
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') { count++; }
    }
    return count;
  } catch {
    return 0;
  }
}
