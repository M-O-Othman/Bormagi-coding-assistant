// ─── Instruction Resolver ─────────────────────────────────────────────────────
//
// Loads and merges the two durable instruction layers from the workspace:
//
//   .bormagi/instructions/global.md   — always loaded; applies to every agent
//   .bormagi/instructions/repo.md     — repo-specific conventions and rules
//
// Both files are optional.  When absent the layer contributes an empty string.
// The effective instructions are capped at a configurable token budget so
// large instruction files cannot crowd out the rest of the context.
//
// Spec reference: §FR-4A (OQ-6: A — .bormagi/instructions/*.md only,
//                          OQ-7: B — global.md + repo.md, no per-directory).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import type { EffectiveInstructions, InstructionLayer } from './types';
import { estimateTokens } from './BudgetEngine';

// ─── File locations ───────────────────────────────────────────────────────────

export const INSTRUCTION_DIR = '.bormagi/instructions';
export const GITHUB_INSTRUCT_DIR = '.github/instructions';
export const GLOBAL_INSTRUCTION = 'global.md';
export const REPO_INSTRUCTION = 'repo.md';
export const COPILOT_INSTRUCTION = '.github/copilot-instructions.md';
export const AGENTS_INSTRUCTION = 'AGENTS.md';

// ─── Layer loader ─────────────────────────────────────────────────────────────

/** Extremely primitive glob matcher to handle basic applyTo scenarios */
function matchesGlob(pattern: string, testPaths: string[]): boolean {
  const regexSource = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  const regex = new RegExp(`^${regexSource}$`);
  return testPaths.some(p => regex.test(p));
}

function loadLayer(absolutePath: string, role: string, candidatePaths: string[] = []): InstructionLayer {
  const exists = fs.existsSync(absolutePath);
  let content = exists ? fs.readFileSync(absolutePath, 'utf8').trim() : '';

  // Parse YAML Frontmatter for path-scoped instructions (FR-052)
  if (content.startsWith('---')) {
    const endMatch = content.indexOf('---', 3);
    if (endMatch !== -1) {
      const frontmatterText = content.substring(3, endMatch).trim();
      const body = content.substring(endMatch + 3).trim();
      try {
        const metadata = yaml.load(frontmatterText) as { applyTo?: string[] };
        // If it specifies applyTo, we must have a match to include it.
        if (metadata?.applyTo && Array.isArray(metadata.applyTo)) {
          const isMatch = candidatePaths.length > 0 &&
            metadata.applyTo.some(pattern => matchesGlob(pattern, candidatePaths));
          if (!isMatch) {
            content = ''; // Does not apply
          } else {
            content = body; // Applies, strip frontmatter
          }
        } else {
          content = body; // No conditions, just strip frontmatter
        }
      } catch (e) {
        // Fallback: don't parse, just use raw content if YAML fails
      }
    }
  }

  return {
    role: role as any,
    filePath: absolutePath,
    content,
    tokenEstimate: estimateTokens(content),
    missing: !exists,
  };
}

// ─── Token-bounded merge ──────────────────────────────────────────────────────

function getMaxTokens(): number {
  return vscode.workspace.getConfiguration('bormagi.contextPipeline')
    .get<number>('instructions.maxTokens', 2000) ?? 2000;
}

/**
 * Merge instruction layers into a single string, respecting `maxTokens`.
 *
 * Layers are merged in order (global first, repo second).  When the combined
 * content would exceed `maxTokens`, the lower-priority layer is truncated.
 */
function mergeLayers(layers: InstructionLayer[], maxTokens: number): string {
  const parts: string[] = [];
  let remaining = maxTokens;

  for (const layer of layers) {
    if (!layer.content || remaining <= 0) { continue; }

    if (layer.tokenEstimate <= remaining) {
      parts.push(layer.content);
      remaining -= layer.tokenEstimate;
    } else {
      // Truncate to fit.
      const charBudget = remaining * 4;
      const truncated = layer.content.slice(0, charBudget - 20) + '\n…[truncated]';
      parts.push(truncated);
      remaining = 0;
    }
  }

  return parts.join('\n\n---\n\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve instruction layers for the current workspace.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 * @returns              `EffectiveInstructions` containing merged content and
 *                       provenance metadata for both layers.
 */
export function resolveInstructions(workspaceRoot: string, candidatePaths: string[] = []): EffectiveInstructions {
  const instrDir = path.join(workspaceRoot, INSTRUCTION_DIR);
  const githubDir = path.join(workspaceRoot, GITHUB_INSTRUCT_DIR);

  const globalLayer = loadLayer(path.join(instrDir, GLOBAL_INSTRUCTION), 'global', candidatePaths);
  const repoLayer = loadLayer(path.join(instrDir, REPO_INSTRUCTION), 'repo', candidatePaths);
  const copilotLayer = loadLayer(path.join(workspaceRoot, COPILOT_INSTRUCTION), 'copilot', candidatePaths);
  const agentsLayer = loadLayer(path.join(workspaceRoot, AGENTS_INSTRUCTION), 'agents', candidatePaths);

  const layers: InstructionLayer[] = [globalLayer, repoLayer, copilotLayer, agentsLayer];

  // Also load any scoped instructions in .github/instructions/
  if (fs.existsSync(githubDir)) {
    const files = fs.readdirSync(githubDir);
    for (const file of files) {
      if (file.endsWith('.instructions.md') || file.endsWith('.md')) {
        layers.push(loadLayer(path.join(githubDir, file), 'scoped', candidatePaths));
      }
    }
  }

  const maxTokens = getMaxTokens();
  const merged = mergeLayers(layers, maxTokens);

  return {
    merged,
    layers,
    totalTokenEstimate: estimateTokens(merged),
  } satisfies EffectiveInstructions;
}

/**
 * Write a starter instruction file if it does not already exist.
 * Used by the workspace initialisation wizard.
 *
 * @param workspaceRoot  Absolute workspace root.
 * @param filename       `'global.md'` or `'repo.md'`.
 * @param content        Default content to write.
 */
export function ensureInstructionFile(
  workspaceRoot: string,
  filename: typeof GLOBAL_INSTRUCTION | typeof REPO_INSTRUCTION,
  content: string,
): void {
  const filePath = path.join(workspaceRoot, INSTRUCTION_DIR, filename);
  if (fs.existsSync(filePath)) { return; }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
