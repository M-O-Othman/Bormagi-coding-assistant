// ─── Observability logger ────────────────────────────────────────────────────
//
// File-based observability logging for agent runs.
// Logs full run traces to .bormagi/logs/runs/
// Interface designed for future OpenTelemetry integration.

import * as fs from 'fs';
import * as path from 'path';

/** A complete run trace. */
export interface RunTrace {
    runId: string;
    agentId: string;
    timestamp: string;
    /** Duration in milliseconds. */
    durationMs: number;
    /** Input tokens used. */
    inputTokens: number;
    /** Output tokens used. */
    outputTokens: number;
    /** Model used. */
    model: string;
    /** Tool calls made during this run. */
    toolCalls: Array<{ name: string; durationMs: number }>;
    /** Whether knowledge retrieval was performed. */
    retrievalPerformed: boolean;
    /** Number of knowledge chunks retrieved. */
    retrievalChunkCount: number;
    /** Outcome status. */
    status: 'success' | 'error' | 'cancelled';
    /** Error message if status is 'error'. */
    errorMessage?: string;
}

export class ObservabilityLogger {
    private readonly logDir: string;

    constructor(workspaceRoot: string) {
        this.logDir = path.join(workspaceRoot, '.bormagi', 'logs', 'runs');
    }

    /** Log a complete run trace. */
    log(trace: RunTrace): void {
        try {
            fs.mkdirSync(this.logDir, { recursive: true });

            const date = trace.timestamp.split('T')[0];
            const logFile = path.join(this.logDir, `${date}.jsonl`);
            const entry = JSON.stringify(trace) + '\n';
            fs.appendFileSync(logFile, entry, 'utf-8');
        } catch (err) {
            console.error('ObservabilityLogger: Failed to write log:', err);
        }
    }

    /** Read traces for a given date. */
    readTraces(date: string): RunTrace[] {
        const logFile = path.join(this.logDir, `${date}.jsonl`);
        if (!fs.existsSync(logFile)) { return []; }

        try {
            return fs.readFileSync(logFile, 'utf-8')
                .split('\n')
                .filter(l => l.trim())
                .map(l => JSON.parse(l));
        } catch {
            return [];
        }
    }

    /** Get a summary of recent run activity. */
    getSummary(days = 7): {
        totalRuns: number;
        avgDurationMs: number;
        avgInputTokens: number;
        avgOutputTokens: number;
        errorRate: number;
        topAgents: Array<{ agentId: string; count: number }>;
    } {
        const now = new Date();
        let totalRuns = 0;
        let totalDuration = 0;
        let totalInput = 0;
        let totalOutput = 0;
        let errors = 0;
        const agentCounts = new Map<string, number>();

        for (let d = 0; d < days; d++) {
            const date = new Date(now.getTime() - d * 86400000).toISOString().split('T')[0];
            const traces = this.readTraces(date);
            for (const t of traces) {
                totalRuns++;
                totalDuration += t.durationMs;
                totalInput += t.inputTokens;
                totalOutput += t.outputTokens;
                if (t.status === 'error') { errors++; }
                agentCounts.set(t.agentId, (agentCounts.get(t.agentId) || 0) + 1);
            }
        }

        const topAgents = Array.from(agentCounts.entries())
            .map(([agentId, count]) => ({ agentId, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        return {
            totalRuns,
            avgDurationMs: totalRuns > 0 ? Math.round(totalDuration / totalRuns) : 0,
            avgInputTokens: totalRuns > 0 ? Math.round(totalInput / totalRuns) : 0,
            avgOutputTokens: totalRuns > 0 ? Math.round(totalOutput / totalRuns) : 0,
            errorRate: totalRuns > 0 ? errors / totalRuns : 0,
            topAgents,
        };
    }
}
