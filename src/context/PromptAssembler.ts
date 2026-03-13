// ─── Prompt Assembler ─────────────────────────────────────────────────────────
//
// Builds the full system prompt for the LLM from discrete context sections.
//
// Section order (spec §13):
//   1. system          — role and identity
//   2. rules           — effective instructions (global.md + repo.md)
//   3. memory          — session memory candidates
//   4. repoMap         — serialised repo map slice
//   5. task            — user's current request
//   6. editable        — files the model is allowed to modify
//   7. reference       — read-only code snippets
//   8. toolArtifacts   — normalised tool output
//   9. conversationTail — recent turns (from envelope)
//  10. outputContract  — mode-specific structured output instructions
//
// Spec reference: §FR-6 + §FR-13.

import type {
  AssistantMode,
  ContextCandidate,
  ContextEnvelope,
  EffectiveInstructions,
  RepoMap,
} from './types';
import { serializeRepoMapSlice } from '../index/RepoMapStore';
import { getModeBudget } from '../config/ModeBudgets';
import { loadOutputContract } from './ModePromptLoader';

// ─── Assembly inputs ──────────────────────────────────────────────────────────

export interface PromptAssemblyArgs {
  /** Role/identity preamble — usually from the agent's system prompt. */
  systemPreamble: string;
  /** Merged instruction layers from `InstructionResolver`. */
  instructions: EffectiveInstructions;
  /** Composed and budget-enforced context envelope. */
  envelope: ContextEnvelope;
  /** Repo map for the workspace (may be null if not yet built). */
  repoMap: RepoMap | null;
  /** The user's raw current message. */
  userMessage: string;
  /** Current assistant mode — drives the output contract. */
  mode: AssistantMode;
  /** Agent name — used in the identity section. */
  agentName?: string;
  /** Project name — used in the identity section. */
  projectName?: string;
  /** Absolute path to the extension root, used to resolve mode prompt .md files. */
  extensionRoot?: string;
  /** Absolute path to the workspace root, used to resolve workspace-override prompt .md files. */
  workspaceRoot?: string;
  /** Whether the agent is currently operating inside a sandbox workspace. */
  isSandboxed?: boolean;
}

// ─── Section formatters ───────────────────────────────────────────────────────

function sectionHeader(title: string): string {
  return `\n\n## ${title}\n`;
}

function formatCandidateBlock(c: ContextCandidate, label: string): string {
  const pathStr = c.path ? ` — \`${c.path}\`` : '';
  return `### ${label}${pathStr}\n\`\`\`\n${c.content.trim()}\n\`\`\``;
}

function formatEditableFiles(candidates: ContextCandidate[]): string {
  if (candidates.length === 0) { return ''; }
  const blocks = candidates.map((c, i) => formatCandidateBlock(c, `Editable File ${i + 1}`));
  return `${sectionHeader('Files to Modify')}${blocks.join('\n\n')}`;
}

function formatReferenceContext(candidates: ContextCandidate[]): string {
  if (candidates.length === 0) { return ''; }
  const blocks = candidates.map((c, i) => {
    const kindLabel = c.kind === 'repo-map' ? 'Repo Map' : `Reference ${i + 1}`;
    return formatCandidateBlock(c, kindLabel);
  });
  return `${sectionHeader('Reference Context')}${blocks.join('\n\n')}`;
}

function formatMemory(candidates: ContextCandidate[]): string {
  if (candidates.length === 0) { return ''; }
  const content = candidates.map(c => c.content.trim()).join('\n\n');
  return `${sectionHeader('Session Memory')}${content}`;
}

function formatToolOutputs(candidates: ContextCandidate[]): string {
  if (candidates.length === 0) { return ''; }
  const blocks = candidates.map((c, i) =>
    `### Tool Output ${i + 1}\n${c.content.trim()}`,
  );
  return `${sectionHeader('Tool Outputs')}${blocks.join('\n\n')}`;
}

function formatRepoMapSection(repoMap: RepoMap, maxTokens: number): string {
  if (maxTokens <= 0) { return ''; }
  const slice = serializeRepoMapSlice(repoMap, { maxTokens });
  if (!slice.trim()) { return ''; }
  return `${sectionHeader('Repository Overview')}${slice}`;
}

// ─── Output contracts (mode-specific) ────────────────────────────────────────
//
// @deprecated These inline constants are kept as a safety fallback only.
// `assemblePrompt` now loads contracts from editable .md files via
// `loadOutputContract` (ModePromptLoader). This constant will be removed once
// all callers pass `extensionRoot`.

const OUTPUT_CONTRACTS: Record<AssistantMode, string> = {
  ask: `## Output Contract
You are in read-only Ask Mode. You must not modify any files, run commands, or make state changes.

Provide a clear, structured explanation:
- Start with a one-sentence summary
- Answer the question directly using evidence from the codebase
- Cite specific files and symbols where relevant
- List caveats or missing context if applicable
- Suggest a concrete next step if useful`,

  plan: `## Output Contract
Use the \`write_file\` tool to write a plan document to \`.bormagi/plans/<task-name>.md\`. The write_file tool creates parent directories automatically — do NOT run mkdir first. Include:
- **Objective**: what needs to be built or changed
- **Steps**: numbered implementation steps
- **Files**: files to create or modify
- **Risks**: potential issues or open questions
Do NOT implement any code — the plan is for user review before execution.`,

  code: `## Output Contract
You MUST use the \`write_file\` tool to write every file — do NOT just describe the code in text.
- Paths MUST be relative to the workspace root (e.g. \`src/utils/helper.ts\`). Never use absolute paths or /tmp/.
- You can create new files as well as overwrite existing ones.
After writing all files respond with:
- **Changed Files**: list every file written
- **Patch Summary**: concise description of each change
- **Validation Notes**: how to verify the changes are correct`,
};

// ─── Identity preamble ────────────────────────────────────────────────────────

function buildIdentityPreamble(
  mode: AssistantMode,
  agentName: string,
  projectName: string,
  basePreamble: string,
): string {
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  const header = `# ${agentName}${projectName ? ` — ${projectName}` : ''} (${modeLabel} mode)`;
  return basePreamble ? `${header}\n\n${basePreamble}` : header;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Assemble the full system prompt from all context sections.
 *
 * The returned string is intended to be used as the `system` message in the
 * LLM request.  The caller is responsible for budget enforcement before calling
 * this function (via `enforcePreflightBudget`).
 *
 * @param args  All context inputs.
 * @returns     Complete system prompt string.
 */
export function assemblePrompt(args: PromptAssemblyArgs): string {
  const {
    systemPreamble,
    instructions,
    envelope,
    repoMap,
    userMessage,
    mode,
    agentName = 'Bormagi',
    projectName = '',
    extensionRoot,
    workspaceRoot,
    isSandboxed,
  } = args;

  const budget = getModeBudget(mode);
  const parts: string[] = [];

  // 1. Identity / system preamble
  parts.push(buildIdentityPreamble(mode, agentName, projectName, systemPreamble));

  // 2. Rules / instructions
  if (instructions.merged.trim()) {
    parts.push(`${sectionHeader('Instructions')}${instructions.merged.trim()}`);
  }

  // 3. Memory
  parts.push(formatMemory(envelope.memory));

  // 4. Repo map
  if (repoMap && budget.repoMap > 0) {
    parts.push(formatRepoMapSection(repoMap, budget.repoMap));
  }

  // 5. Current task
  if (userMessage.trim()) {
    parts.push(`${sectionHeader('Current Task')}\n${userMessage.trim()}`);
  }

  // 6. Editable files
  parts.push(formatEditableFiles(envelope.editable));

  // 7. Reference context
  parts.push(formatReferenceContext(envelope.reference));

  // 8. Tool outputs
  parts.push(formatToolOutputs(envelope.toolOutputs));

  // 9. Output contract
  let contract = OUTPUT_CONTRACTS[mode];
  if (isSandboxed) {
    contract += `\n\n**Sandbox Environment Active**: You are operating in an isolated sandbox. Your file changes will NOT be visible in the user's main workspace until they are promoted. Upon completing your file modifications, you MUST explicitly instruct the user to run the **"Bormagi: Apply Sandbox Changes"** command to sync your work to their source workspace.`;
  }
  parts.push(`\n\n${contract}`);

  return parts.filter(p => p.trim()).join('');
}

/**
 * Build only the output-contract section for `mode`.
 * Exposed for testing and for callers that compose partial prompts.
 */
export function getOutputContract(mode: AssistantMode): string {
  return OUTPUT_CONTRACTS[mode];
}
