/**
 * Per-turn context cost telemetry for code-mode LLM calls (DD12).
 *
 * Tracks token estimates by source so the team can identify expensive
 * redundant context injections and verify that cost is decreasing.
 */
export interface ContextCostEntry {
  turn: number;
  timestamp: string;
  systemPromptTokens: number;
  executionStateTokens: number;
  workspaceSummaryTokens: number;
  skillFragmentTokens: number;
  currentInstructionTokens: number;
  toolResultTokens: number;
  totalTokens: number;
  resolvedSummariesReused: number;
  rawFileContentsInjected: number;
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
  ): ContextCostEntry {
    const entry: ContextCostEntry = {
      turn,
      timestamp: new Date().toISOString(),
      systemPromptTokens: this.estimateTokens(systemPrompt),
      executionStateTokens: this.estimateTokens(executionState),
      workspaceSummaryTokens: this.estimateTokens(workspaceSummary),
      skillFragmentTokens: this.estimateTokens(skillFragments),
      currentInstructionTokens: this.estimateTokens(currentInstruction),
      toolResultTokens: this.estimateTokens(toolResults),
      totalTokens: 0,
      resolvedSummariesReused: this._resolvedSummariesReused,
      rawFileContentsInjected: this._rawFileContentsInjected,
      llmCallsSkipped: this._llmCallsSkipped,
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
  getSummary(): { totalTurns: number; totalTokens: number; avgTokensPerTurn: number; llmCallsSkipped: number } {
    const totalTokens = this.entries.reduce((sum, e) => sum + e.totalTokens, 0);
    return {
      totalTurns: this.entries.length,
      totalTokens,
      avgTokensPerTurn: this.entries.length > 0 ? Math.round(totalTokens / this.entries.length) : 0,
      llmCallsSkipped: this._llmCallsSkipped,
    };
  }
}
