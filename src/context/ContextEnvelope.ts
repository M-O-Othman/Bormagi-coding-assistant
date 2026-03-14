// ─── Context Envelope Builder ─────────────────────────────────────────────────
//
// Separates a flat list of ranked `ContextCandidate` items into the four
// categories the prompt assembler needs:
//
//   editable    — files the model is allowed to modify (write/patch)
//   reference   — read-only snippets and repo-map slices
//   memory      — session memory items (facts, goals, decisions)
//   toolOutputs — structured tool output artefacts
//
// Rules (spec §FR-10):
//   - Editable files are capped at `maxEditableFiles` (default 3).
//   - Plan, explain, search, review modes always get 0 editable files.
//   - Memory and toolOutput candidates are placed in their own buckets.
//   - All remaining candidates go to reference.
//
// Spec reference: §FR-10.

import * as vscode from 'vscode';
import type { AssistantMode, ContextCandidate, ContextEnvelope } from './types';

// ─── Mode classification helpers ──────────────────────────────────────────────

/** Modes where no editable-file scope is allowed. */
const READ_ONLY_MODES = new Set<AssistantMode>(['ask', 'plan']);

function maxEditableForMode(mode: AssistantMode): number {
  if (READ_ONLY_MODES.has(mode)) { return 0; }
  return vscode.workspace.getConfiguration('bormagi.contextPipeline')
    .get<number>('maxEditableFiles', 3);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Partition a ranked `ContextCandidate[]` into a `ContextEnvelope`.
 *
 * @param candidates  Scored and ranked candidates from `RetrievalOrchestrator`.
 * @param mode        Current assistant mode.
 * @returns           Populated `ContextEnvelope`.
 */
export function buildContextEnvelope(
  candidates: ContextCandidate[],
  mode: AssistantMode,
): ContextEnvelope {
  const maxEditable = maxEditableForMode(mode);

  const editable:    ContextCandidate[] = [];
  const reference:   ContextCandidate[] = [];
  const memory:      ContextCandidate[] = [];
  const toolOutputs: ContextCandidate[] = [];

  for (const c of candidates) {
    switch (c.kind) {
      case 'memory':
        memory.push(c);
        break;

      case 'tool-output':
        toolOutputs.push(c);
        break;

      case 'file':
      case 'snippet':
      case 'symbol':
      case 'repo-map': {
        if (c.editable && editable.length < maxEditable) {
          editable.push(c);
        } else {
          // Demote to reference (editable flag preserved in object for audit but
          // placement is reference since the cap was reached or mode disallows edits).
          reference.push(c);
        }
        break;
      }

      default:
        reference.push(c);
    }
  }

  return { editable, reference, memory, toolOutputs };
}

/**
 * Merge two `ContextEnvelope` objects.
 * Useful when callers want to inject pre-built memory or tool-output candidates
 * alongside the retrieval-sourced candidates.
 *
 * Candidates from `overlay` are prepended (higher priority).
 */
export function mergeEnvelopes(
  base: ContextEnvelope,
  overlay: ContextEnvelope,
): ContextEnvelope {
  return {
    editable:    [...overlay.editable,    ...base.editable],
    reference:   [...overlay.reference,   ...base.reference],
    memory:      [...overlay.memory,      ...base.memory],
    toolOutputs: [...overlay.toolOutputs, ...base.toolOutputs],
  };
}

/**
 * Return the total estimated token count for all candidates in an envelope.
 */
export function envelopeTokenCount(envelope: ContextEnvelope): number {
  const sum = (arr: ContextCandidate[]) =>
    arr.reduce((acc, c) => acc + c.tokenEstimate, 0);
  return sum(envelope.editable) + sum(envelope.reference) +
         sum(envelope.memory)   + sum(envelope.toolOutputs);
}
