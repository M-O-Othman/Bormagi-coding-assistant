// ─── Enhanced Session Memory ──────────────────────────────────────────────────
//
// Wraps the existing SessionMemory with the structured context fields required
// by the context/token management spec (§FR-4):
//
//   currentGoal            — the active user objective
//   currentPlan            — ordered list of pending steps
//   unresolvedQuestions    — open questions raised during the session
//   recentEditedFiles      — up to 20 most-recently modified files (relative paths)
//   recentFailures         — last N error / failed-test summaries
//   recentSuccesses        — last N successful outcomes worth remembering
//   decisions              — architecture decisions (title + decision + rationale)
//   codingConventions      — project-specific conventions extracted from instructions
//
// Non-breaking: this class is additive.  It stores its state alongside the
// existing memory files under .bormagi/memory/<agent-id>/enhanced-state.json
// and does not modify SessionMemory.ts.
//
// Spec reference: §FR-4 + §FR-9 (OQ answer: workspace-local JSON, per §28 answer 4).

import * as fs from 'fs';
import * as path from 'path';
import type {
  EnhancedSessionMemoryState,
  ArchitectureDecision,
  AssistantMode,
} from '../context/types';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const MAX_RECENT_FILES    = 20;
const MAX_RECENT_FAILURES = 10;
const MAX_RECENT_SUCCESSES = 10;
const MAX_DECISIONS       = 50;

function emptyState(): EnhancedSessionMemoryState {
  return {
    codingConventions:    [],
    decisions:            [],
    currentPlan:          [],
    unresolvedQuestions:  [],
    recentEditedFiles:    [],
    recentFailures:       [],
    recentSuccesses:      [],
    updatedAtUtc:         new Date().toISOString(),
  };
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class EnhancedSessionMemory {
  private readonly stateDir: string;
  private cache = new Map<string, EnhancedSessionMemoryState>();

  constructor(private readonly workspaceRoot: string) {
    this.stateDir = path.join(workspaceRoot, '.bormagi', 'memory');
  }

  // ─── State loading / saving ─────────────────────────────────────────────────

  getState(agentId: string): EnhancedSessionMemoryState {
    if (!this.cache.has(agentId)) {
      this.cache.set(agentId, this.loadFromDisk(agentId) ?? emptyState());
    }
    return this.cache.get(agentId)!;
  }

  async persistState(agentId: string): Promise<void> {
    const state = this.cache.get(agentId);
    if (!state) { return; }
    const dir = path.join(this.stateDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'enhanced-state.json'),
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  }

  // ─── Goal and plan ──────────────────────────────────────────────────────────

  setGoal(agentId: string, goal: string): void {
    const s = this.getState(agentId);
    s.currentGoal = goal.trim();
    s.updatedAtUtc = new Date().toISOString();
  }

  setPlan(agentId: string, steps: string[]): void {
    const s = this.getState(agentId);
    s.currentPlan = steps.map(t => t.trim()).filter(Boolean);
    s.updatedAtUtc = new Date().toISOString();
  }

  markStepDone(agentId: string, stepIndex: number): void {
    const s = this.getState(agentId);
    s.currentPlan = s.currentPlan.filter((_, i) => i !== stepIndex);
    s.updatedAtUtc = new Date().toISOString();
  }

  // ─── Questions ──────────────────────────────────────────────────────────────

  addUnresolvedQuestion(agentId: string, question: string): void {
    const s = this.getState(agentId);
    if (!s.unresolvedQuestions.includes(question)) {
      s.unresolvedQuestions.push(question.trim());
      s.updatedAtUtc = new Date().toISOString();
    }
  }

  resolveQuestion(agentId: string, question: string): void {
    const s = this.getState(agentId);
    s.unresolvedQuestions = s.unresolvedQuestions.filter(q => q !== question);
    s.updatedAtUtc = new Date().toISOString();
  }

  // ─── File edit tracking ─────────────────────────────────────────────────────

  recordEditedFile(agentId: string, relativePath: string): void {
    const s = this.getState(agentId);
    // Move to front and cap.
    s.recentEditedFiles = [
      relativePath,
      ...s.recentEditedFiles.filter(p => p !== relativePath),
    ].slice(0, MAX_RECENT_FILES);
    s.updatedAtUtc = new Date().toISOString();
  }

  // ─── Failure / success tracking ─────────────────────────────────────────────

  recordFailure(agentId: string, summary: string): void {
    const s = this.getState(agentId);
    s.recentFailures = [summary, ...s.recentFailures].slice(0, MAX_RECENT_FAILURES);
    s.updatedAtUtc = new Date().toISOString();
  }

  recordSuccess(agentId: string, summary: string): void {
    const s = this.getState(agentId);
    s.recentSuccesses = [summary, ...s.recentSuccesses].slice(0, MAX_RECENT_SUCCESSES);
    s.updatedAtUtc = new Date().toISOString();
  }

  // ─── Architecture decisions ─────────────────────────────────────────────────

  addDecision(agentId: string, decision: Omit<ArchitectureDecision, 'id'>): ArchitectureDecision {
    const s = this.getState(agentId);
    const full: ArchitectureDecision = {
      id: `adr-${Date.now()}`,
      ...decision,
    };
    s.decisions = [full, ...s.decisions].slice(0, MAX_DECISIONS);
    s.updatedAtUtc = new Date().toISOString();
    return full;
  }

  // ─── Coding conventions ──────────────────────────────────────────────────────

  addCodingConvention(agentId: string, convention: string): void {
    const s = this.getState(agentId);
    if (!s.codingConventions.includes(convention)) {
      s.codingConventions.push(convention.trim());
      s.updatedAtUtc = new Date().toISOString();
    }
  }

  // ─── Prompt injection ───────────────────────────────────────────────────────

  /**
   * Build a compact text summary of the enhanced state for inclusion in the
   * session-memory section of the assembled prompt.
   *
   * Returns an empty string when there is nothing meaningful to include.
   */
  buildPromptSummary(agentId: string, mode: AssistantMode): string {
    const s = this.getState(agentId);
    const parts: string[] = [];

    if (s.currentGoal) {
      parts.push(`**Current goal:** ${s.currentGoal}`);
    }

    if (s.currentPlan.length > 0) {
      parts.push(`**Plan:**\n${s.currentPlan.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
    }

    if (s.unresolvedQuestions.length > 0) {
      parts.push(`**Open questions:**\n${s.unresolvedQuestions.map(q => `- ${q}`).join('\n')}`);
    }

    if (s.recentEditedFiles.length > 0) {
      parts.push(`**Recently edited:** ${s.recentEditedFiles.slice(0, 10).join(', ')}`);
    }

    if (s.decisions.length > 0) {
      const top = s.decisions.slice(0, 5);
      const lines = top.map(d => `- **${d.title}**: ${d.decision}`);
      parts.push(`**Architecture decisions:**\n${lines.join('\n')}`);
    }

    if ((mode === 'debug' || mode === 'test-fix') && s.recentFailures.length > 0) {
      parts.push(`**Recent failures:**\n${s.recentFailures.slice(0, 3).map(f => `- ${f}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  // ─── Disk I/O ───────────────────────────────────────────────────────────────

  private loadFromDisk(agentId: string): EnhancedSessionMemoryState | null {
    const filePath = path.join(this.stateDir, agentId, 'enhanced-state.json');
    if (!fs.existsSync(filePath)) { return null; }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Merge with empty state so missing fields are always initialised.
      return { ...emptyState(), ...parsed };
    } catch {
      return null;
    }
  }
}
