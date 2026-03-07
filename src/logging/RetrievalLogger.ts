// ─── Retrieval logger ────────────────────────────────────────────────────────
//
// Logs retrieval queries for observability and debugging.
// Writes JSON log entries to .bormagi/logs/retrieval/
// Designed to be extensible for future metrics (recall@K, precision@K, etc.)

import * as fs from 'fs';
import * as path from 'path';
import type { RetrievalTrace } from '../knowledge/types';

export class RetrievalLogger {
    private readonly logDir: string;

    constructor(workspaceRoot: string) {
        this.logDir = path.join(workspaceRoot, '.bormagi', 'logs', 'retrieval');
    }

    /**
     * Log a single retrieval trace.
     */
    log(trace: RetrievalTrace): void {
        try {
            fs.mkdirSync(this.logDir, { recursive: true });

            // Use date-based log file (one per day)
            const date = trace.timestamp.split('T')[0]; // YYYY-MM-DD
            const logFile = path.join(this.logDir, `${date}.jsonl`);

            const entry = JSON.stringify(trace) + '\n';
            fs.appendFileSync(logFile, entry, 'utf-8');
        } catch (err) {
            console.error('RetrievalLogger: Failed to write log:', err);
        }
    }

    /**
     * Read all log entries for a given date.
     */
    readLogs(date: string): RetrievalTrace[] {
        const logFile = path.join(this.logDir, `${date}.jsonl`);
        if (!fs.existsSync(logFile)) { return []; }

        try {
            const lines = fs.readFileSync(logFile, 'utf-8')
                .split('\n')
                .filter(line => line.trim());
            return lines.map(line => JSON.parse(line));
        } catch {
            return [];
        }
    }

    /**
     * Get a summary of recent retrieval activity.
     */
    getSummary(days = 7): {
        totalQueries: number;
        avgLatencyMs: number;
        avgResultCount: number;
        topSources: Array<{ filename: string; count: number }>;
    } {
        const now = new Date();
        let totalQueries = 0;
        let totalLatency = 0;
        let totalResults = 0;
        const sourceCounts = new Map<string, number>();

        for (let d = 0; d < days; d++) {
            const date = new Date(now.getTime() - d * 86400000);
            const dateStr = date.toISOString().split('T')[0];
            const traces = this.readLogs(dateStr);

            for (const trace of traces) {
                totalQueries++;
                totalLatency += trace.latencyMs;
                totalResults += trace.resultCount;
                for (const src of trace.sources) {
                    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
                }
            }
        }

        const topSources = Array.from(sourceCounts.entries())
            .map(([filename, count]) => ({ filename, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            totalQueries,
            avgLatencyMs: totalQueries > 0 ? Math.round(totalLatency / totalQueries) : 0,
            avgResultCount: totalQueries > 0 ? Math.round(totalResults / totalQueries) : 0,
            topSources,
        };
    }
}
