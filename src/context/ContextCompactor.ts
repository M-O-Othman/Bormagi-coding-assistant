// ─── Context Compactor ────────────────────────────────────────────────────────
//
// Compacts a long conversation history into a structured summary when the token
// count approaches the model's soft limit, freeing budget for new turns.
//
// Design decisions (from spec answers):
//   OQ-8  (C): Automatic compaction — no user prompt; triggered transparently.
//   OQ-9  (A): Never show raw compaction diff to user; surface a status thought.
//   §28-3     : Same primary model is used for compaction (no separate model).
//
// The compactor is deliberately side-effect-free: it returns a `CompactionOutput`
// but does NOT mutate the caller's message array — the caller is responsible for
// reinserting the compact summary.
//
// Spec reference: §FR-8 + §FR-9.

import type { ILLMProvider } from '../providers/ILLMProvider';
import type {
  AssistantMode,
  CompactionInput,
  CompactionOutput,
  CompactedHistory,
  ModelProfile,
} from './types';

// ─── Trigger threshold ────────────────────────────────────────────────────────

/**
 * Fraction of the model's soft input budget at which compaction kicks in.
 * At 80 % of `recommendedInputBudget` we compact proactively.
 */
const COMPACT_AT_FRACTION = 0.80;

/**
 * Minimum number of messages needed before compaction makes sense.
 * Avoids compacting very short sessions where it provides no value.
 */
const MIN_MESSAGES_TO_COMPACT = 6;

// ─── Prompt ───────────────────────────────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You are a context compaction assistant.
Your job is to compress a long AI coding session into a concise structured summary.
Preserve everything that matters for resuming the work; discard conversational filler,
failed attempts that were superseded, and raw log dumps.

Respond with valid JSON only — no markdown fences, no extra text.`;

function buildCompactionUserPrompt(input: CompactionInput): string {
  const transcriptText = input.transcript
    .map(t => `[${t.role.toUpperCase()}]\n${t.content}`)
    .join('\n\n---\n\n');

  const artifactsText = input.recentArtifacts.length > 0
    ? `\n\nRecent artifacts produced:\n${input.recentArtifacts.map(a => `- ${a}`).join('\n')}`
    : '';

  return `Current mode: ${input.activeMode}
Current goal: ${input.currentGoal ?? '(not specified)'}
${artifactsText}

FULL TRANSCRIPT (${input.transcript.length} messages):
${transcriptText}

Produce a JSON object with this exact shape:
{
  "currentObjective": "one sentence describing what the user is trying to accomplish",
  "decisions": ["list of architecture / implementation decisions made so far"],
  "blockers": ["unresolved blockers or open questions"],
  "recentActions": ["last 5 meaningful actions taken by the assistant"],
  "recentArtifacts": ["files created or edited"],
  "pendingNextSteps": ["ordered list of what needs to happen next"],
  "narrativeSummary": "2-3 paragraph plain-text summary of the session"
}`;
}

// ─── Compacted history fallback ───────────────────────────────────────────────

function fallbackCompactedHistory(input: CompactionInput): CompactedHistory {
  const lastTurns = input.transcript.slice(-4);
  const recentActions = lastTurns
    .filter(t => t.role === 'assistant')
    .map(t => t.content.slice(0, 120).replace(/\n/g, ' '));

  return {
    currentObjective: input.currentGoal ?? 'Continue the current task.',
    decisions:        [],
    blockers:         [],
    recentActions,
    recentArtifacts:  input.recentArtifacts.slice(-5),
    pendingNextSteps: [],
    narrativeSummary: `Session compacted after ${input.transcript.length} messages.`,
  };
}

// ─── Narrative builder (for reinsertion) ─────────────────────────────────────

/**
 * Format the compact history into a human-readable block suitable for
 * reinsertion as the first assistant turn after compaction.
 */
export function formatCompactedHistory(h: CompactedHistory): string {
  const lines: string[] = [
    `[Session compacted — context summary]`,
    ``,
    `**Objective:** ${h.currentObjective}`,
  ];

  if (h.decisions.length > 0) {
    lines.push(`\n**Decisions made:**`);
    h.decisions.forEach(d => lines.push(`- ${d}`));
  }

  if (h.blockers.length > 0) {
    lines.push(`\n**Blockers / open questions:**`);
    h.blockers.forEach(b => lines.push(`- ${b}`));
  }

  if (h.recentArtifacts.length > 0) {
    lines.push(`\n**Files changed:**`);
    h.recentArtifacts.forEach(a => lines.push(`- ${a}`));
  }

  if (h.pendingNextSteps.length > 0) {
    lines.push(`\n**Pending next steps:**`);
    h.pendingNextSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  if (h.narrativeSummary) {
    lines.push(`\n**Summary:**\n${h.narrativeSummary}`);
  }

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine whether compaction should be triggered for the current session.
 *
 * @param historyTokens  Estimated token count of the current conversation history.
 * @param profile        Active model profile (provides the soft budget).
 * @param messageCount   Number of messages in the history.
 * @returns              `true` when compaction is warranted.
 */
export function shouldCompact(
  historyTokens: number,
  profile: ModelProfile,
  messageCount: number,
): boolean {
  if (messageCount < MIN_MESSAGES_TO_COMPACT) { return false; }
  const threshold = Math.floor(profile.recommendedInputBudget * COMPACT_AT_FRACTION);
  return historyTokens >= threshold;
}

/**
 * Compact a conversation transcript into a structured summary.
 *
 * Uses the provided LLM provider to generate the summary.  Falls back to a
 * deterministic heuristic summary on any provider error.
 *
 * @param input     The transcript and metadata to compact.
 * @param provider  LLM provider instance (same model as the primary agent).
 * @param mode      Current assistant mode.
 * @returns         Structured `CompactionOutput`.
 */
export async function compact(
  input: CompactionInput,
  provider: ILLMProvider,
  mode: AssistantMode,
): Promise<CompactionOutput> {
  const userPrompt = buildCompactionUserPrompt(input);

  let rawJson = '';
  try {
    for await (const event of provider.stream(
      [
        { role: 'system',  content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user',    content: userPrompt },
      ],
      [],    // no tools during compaction
      1200,  // max output tokens for the summary
    )) {
      if (event.type === 'text') { rawJson += event.delta; }
    }

    // Strip any accidental markdown fences the model may have emitted.
    const cleaned = rawJson.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed: CompactedHistory = JSON.parse(cleaned);

    // Sanity-check required fields.
    const structured: CompactedHistory = {
      currentObjective: parsed.currentObjective ?? input.currentGoal ?? 'Continue.',
      decisions:        Array.isArray(parsed.decisions)        ? parsed.decisions        : [],
      blockers:         Array.isArray(parsed.blockers)         ? parsed.blockers         : [],
      recentActions:    Array.isArray(parsed.recentActions)    ? parsed.recentActions    : [],
      recentArtifacts:  Array.isArray(parsed.recentArtifacts)  ? parsed.recentArtifacts  : input.recentArtifacts,
      pendingNextSteps: Array.isArray(parsed.pendingNextSteps) ? parsed.pendingNextSteps : [],
      narrativeSummary: parsed.narrativeSummary,
    };

    return {
      structured,
      narrative:       formatCompactedHistory(structured),
      droppedMessages: input.transcript.length,
    };

  } catch {
    // Fall back gracefully — never crash the pipeline on a compaction failure.
    const structured = fallbackCompactedHistory(input);
    return {
      structured,
      narrative:       formatCompactedHistory(structured),
      droppedMessages: input.transcript.length,
    };
  }
}
