// ─── Mode Prompt Loader ────────────────────────────────────────────────────────
//
// Loads mode-specific output contract text from editable .md files.
//
// Resolution order (first found wins):
//   1. <workspaceRoot>/.bormagi/prompts/modes/<mode>.md  (workspace override)
//   2. <extensionRoot>/src/context/prompts/modes/<mode>.md  (packaged default)
//   3. Inline fallback string (safety net)
//
// This allows teams to customise output contracts per repo without changing
// extension source code.

import * as fs   from 'fs';
import * as path from 'path';
import type { AssistantMode } from './types';

// Cache to avoid repeated disk reads within a session.
const cache = new Map<string, string>();

/**
 * Load the output-contract markdown for `mode`.
 *
 * @param mode           The active assistant mode.
 * @param extensionRoot  Absolute path to the extension's root directory.
 * @param workspaceRoot  Absolute path to the workspace root (optional).
 * @returns              The output-contract markdown string.
 */
export function loadOutputContract(
  mode: AssistantMode,
  extensionRoot: string,
  workspaceRoot?: string,
): string {
  // Alias resolution: treat `ask` as `ask`, `code` as `code` (each has its own file)
  const fileMode = mode === 'ask' ? 'ask' : mode === 'code' ? 'code' : mode;
  const cacheKey = `${workspaceRoot ?? ''}::${fileMode}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const candidates: string[] = [];

  // 1. Workspace override
  if (workspaceRoot) {
    candidates.push(path.join(workspaceRoot, '.bormagi', 'prompts', 'modes', `${fileMode}.md`));
  }

  // 2. Packaged default (next to this compiled file at runtime, or in src/ during dev)
  candidates.push(path.join(extensionRoot, 'src', 'context', 'prompts', 'modes', `${fileMode}.md`));
  // Also check compiled output location
  candidates.push(path.join(extensionRoot, 'out', 'context', 'prompts', 'modes', `${fileMode}.md`));
  candidates.push(path.join(extensionRoot, 'dist', 'context', 'prompts', 'modes', `${fileMode}.md`));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        if (content) {
          cache.set(cacheKey, content);
          return content;
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // 3. Inline fallback
  const fallback = getFallbackContract(mode);
  cache.set(cacheKey, fallback);
  return fallback;
}

/** Clear the contract cache (useful for testing or when workspace changes). */
export function clearContractCache(): void {
  cache.clear();
}

function getFallbackContract(mode: AssistantMode): string {
  const fallbacks: Partial<Record<AssistantMode, string>> = {
    ask:       `## Output Contract\nAnswer the question clearly and concisely. Cite files and symbols. Do not modify any files.`,
    explain:   `## Output Contract\nAnswer the question clearly and concisely. Cite files and symbols.`,
    plan:      `## Output Contract\nProvide a numbered plan with impacted files, steps, and risks. Do not write code.`,
    code:      `## Output Contract\nList changed files, patch summary, and validation notes.`,
    edit:      `## Output Contract\nList changed files, patch summary, and validation notes.`,
    debug:     `## Output Contract\nState root cause hypothesis, evidence, and proposed fix.`,
    review:    `## Output Contract\nStructured review: findings by severity, suggestions, confidence.`,
    search:    `## Output Contract\nList matching results with file path, line, description, relevance.`,
    'test-fix': `## Output Contract\nState failure analysis, root cause, minimal fix, and confidence.`,
  };
  return fallbacks[mode] ?? `## Output Contract\nRespond clearly and concisely.`;
}
