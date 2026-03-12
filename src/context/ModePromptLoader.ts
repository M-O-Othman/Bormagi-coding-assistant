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
  const fileMode = mode;
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
  const fallbacks: Record<AssistantMode, string> = {
    ask:  `## Output Contract\nAnswer the question clearly and concisely. Cite relevant files and symbols. Do NOT modify any files.`,
    plan: `## Output Contract\nWrite a plan document to \`.bormagi/plans/<task-name>.md\`. Include: objective, numbered steps, files to create/modify, risks, and open questions. Do NOT implement any code — the plan is for user review before execution.`,
    code: `## Output Contract\nImplement the task immediately. For simple tasks: write files directly. For complex tasks: read existing files first to understand conventions, then write. End with: Changed Files, Patch Summary, Validation Notes.`,
  };
  return fallbacks[mode];
}
