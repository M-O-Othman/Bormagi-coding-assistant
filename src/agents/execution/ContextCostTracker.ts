/**
 * Per-turn context cost telemetry for code-mode LLM calls (DD12).
 *
 * Tracks token estimates by source so the team can identify expensive
 * redundant context injections and verify that cost is decreasing.
 */
export interface ContextCostEntry {
  turn: number;
  timestamp: string;
  phase: string;
  systemPromptTokens: number;
  executionStateTokens: number;
  workspaceSummaryTokens: number;
  skillFragmentTokens: number;
  currentInstructionTokens: number;
  toolResultTokens: number;
  totalTokens: number;
  outputTokens: number;
  resolvedSummariesReused: number;
  rawFileContentsInjected: number;
  llmCallsSkipped: number;
  llmCallSkipped: boolean;
}

export interface PhaseCostSummary {
  phase: string;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCallsSkipped: number;
}

export class ContextCostTracker {
  private readonly entries: ContextCostEntry[] = [];
  private _llmCallsSkipped = 0;
  private _resolvedSummariesReused = 0;
  private _rawFileContentsInjected = 0;

  /** Estimate tokens from a string (rough 4 chars/token). */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Record a context cost entry for a single LLM call. */
  record(
    turn: number,
    systemPrompt: string,
    executionState: string,
    workspaceSummary: string,
    skillFragments: string,
    currentInstruction: string,
    toolResults: string,
    phase: string = 'unknown',
  ): ContextCostEntry {
    const entry: ContextCostEntry = {
      turn,
      timestamp: new Date().toISOString(),
      phase,
      systemPromptTokens: this.estimateTokens(systemPrompt),
      executionStateTokens: this.estimateTokens(executionState),
      workspaceSummaryTokens: this.estimateTokens(workspaceSummary),
      skillFragmentTokens: this.estimateTokens(skillFragments),
      currentInstructionTokens: this.estimateTokens(currentInstruction),
      toolResultTokens: this.estimateTokens(toolResults),
      totalTokens: 0,
      outputTokens: 0,
      resolvedSummariesReused: this._resolvedSummariesReused,
      rawFileContentsInjected: this._rawFileContentsInjected,
      llmCallsSkipped: this._llmCallsSkipped,
      llmCallSkipped: false,
    };
    entry.totalTokens = entry.systemPromptTokens + entry.executionStateTokens +
      entry.workspaceSummaryTokens + entry.skillFragmentTokens +
      entry.currentInstructionTokens + entry.toolResultTokens;
    this.entries.push(entry);
    return entry;
  }

  /** Increment the count of LLM calls skipped due to direct dispatch. */
  recordSkippedLLMCall(): void {
    this._llmCallsSkipped++;
  }

  /** Increment the count of resolved summaries reused instead of raw content. */
  recordSummaryReuse(): void {
    this._resolvedSummariesReused++;
  }

  /** Increment the count of raw file contents injected. */
  recordRawFileInjection(): void {
    this._rawFileContentsInjected++;
  }

  /** Get all entries for audit logging. */
  getEntries(): ContextCostEntry[] {
    return [...this.entries];
  }

  /** Get a summary of total costs across all turns. */
  getSummary(): { totalTurns: number; totalTokens: number; totalOutputTokens: number; avgTokensPerTurn: number; llmCallsSkipped: number } {
    const totalTokens = this.entries.reduce((sum, e) => sum + e.totalTokens, 0);
    const totalOutputTokens = this.entries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
    return {
      totalTurns: this.entries.length,
      totalTokens,
      totalOutputTokens,
      avgTokensPerTurn: this.entries.length > 0 ? Math.round(totalTokens / this.entries.length) : 0,
      llmCallsSkipped: this._llmCallsSkipped,
    };
  }

  /**
   * Get cost breakdown grouped by FSM phase.
   */
  getPhaseBreakdown(): PhaseCostSummary[] {
    const map = new Map<string, PhaseCostSummary>();

    for (const entry of this.entries) {
      const existing = map.get(entry.phase);
      if (existing) {
        existing.turns++;
        existing.totalInputTokens += entry.totalTokens;
        existing.totalOutputTokens += entry.outputTokens;
        if (entry.llmCallSkipped) existing.llmCallsSkipped++;
      } else {
        map.set(entry.phase, {
          phase: entry.phase,
          turns: 1,
          totalInputTokens: entry.totalTokens,
          totalOutputTokens: entry.outputTokens,
          llmCallsSkipped: entry.llmCallSkipped ? 1 : 0,
        });
      }
    }

    return Array.from(map.values());
  }

  /**
   * Get the last N entries for efficiency checks.
   */
  getRecentEntries(n: number): ContextCostEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * Get total LLM calls skipped by deterministic dispatch.
   */
  getSkippedCount(): number {
    return this.entries.filter(e => e.llmCallSkipped).length;
  }

  /**
   * Check if the agent is in an inefficient loop.
   * Returns true if the last `window` turns all have efficiency below `threshold`.
   */
  isInefficient(window: number, threshold: number): boolean {
    const recent = this.getRecentEntries(window);
    if (recent.length < window) return false;

    return recent.every(entry => {
      const efficiency = entry.totalTokens > 0
        ? entry.outputTokens / entry.totalTokens
        : 0;
      return efficiency < threshold;
    });
  }
}
