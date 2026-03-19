import type { ExecutionStateData } from '../ExecutionStateManager';

export interface SessionReportData {
    sessionDurationMs: number;
    writtenPaths: string[];
    readCount: number;
    toolsUsed: string[];
    iterationCount: number;
    maxToolIterations: number;
    execState: ExecutionStateData;
}

export function generateSessionReport(data: SessionReportData): string {
    const { sessionDurationMs, writtenPaths, readCount, toolsUsed, iterationCount, maxToolIterations, execState } = data;
    const durationSec = Math.round(sessionDurationMs / 1000);
    const batchPlanned = execState.plannedFileBatch ?? [];
    const batchCompleted = execState.completedBatchFiles ?? [];
    const batchRemaining = batchPlanned.filter((f: string) => !batchCompleted.includes(f));
    const phase = execState.runPhase ?? 'RUNNING';

    const reportLines: string[] = ['\n\n---', '**Session Report**'];

    if (writtenPaths.length > 0) {
        const fileList = writtenPaths.length <= 8
            ? writtenPaths.map(f => `\`${f}\``).join(', ')
            : writtenPaths.slice(0, 6).map(f => `\`${f}\``).join(', ') + ` and ${writtenPaths.length - 6} more`;
        reportLines.push(`- **Files written/edited:** ${writtenPaths.length} — ${fileList}`);
    }
    if (readCount > 0) {
        reportLines.push(`- **Files read:** ${readCount}`);
    }
    if (toolsUsed.length > 0) {
        const toolCounts = new Map<string, number>();
        for (const t of toolsUsed) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
        const toolSummary = Array.from(toolCounts.entries())
            .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
            .join(', ');
        reportLines.push(`- **Tool operations:** ${toolsUsed.length} (${toolSummary})`);
    }
    reportLines.push(`- **Iterations:** ${iterationCount} | **Duration:** ${durationSec}s`);

    if (batchPlanned.length > 0) {
        reportLines.push(`- **Batch progress:** ${batchCompleted.length}/${batchPlanned.length} files completed`);
        if (batchRemaining.length > 0) {
            const remainList = batchRemaining.length <= 5
                ? batchRemaining.map((f: string) => `\`${f}\``).join(', ')
                : batchRemaining.slice(0, 4).map((f: string) => `\`${f}\``).join(', ') + ` and ${batchRemaining.length - 4} more`;
            reportLines.push(`- **Remaining in batch:** ${remainList}`);
        }
    }

    if (phase === 'WAITING_FOR_USER_INPUT') {
        const reason = execState.waitStateReason ?? '';
        reportLines.push('', '**Action required from you:**');
        if (reason) reportLines.push(`> ${reason}`);
        else if (batchRemaining.length > 0) reportLines.push(`> The agent paused with ${batchRemaining.length} file(s) remaining. Type **continue** to resume writing the remaining files.`);
        else reportLines.push('> The agent is waiting for your input. Please provide instructions or feedback to continue.');
    } else if (phase === 'BLOCKED_BY_VALIDATION') {
        reportLines.push('', '**Action required from you:**', '> The agent is blocked by validation errors. Review the issues above, fix them, and retry.');
    } else if (phase === 'RECOVERY_REQUIRED') {
        reportLines.push('', '**Action required from you:**', '> The execution state is inconsistent. Run the command **Bormagi: Reset Execution State** and retry.');
    } else if (phase === 'PARTIAL_BATCH_COMPLETE') {
        reportLines.push('', '**Action required from you:**', `> Batch phase complete (${batchCompleted.length}/${batchPlanned.length} files). Review the written files and type **continue** to proceed with the next batch.`);
    } else if (phase === 'COMPLETED') {
        if (writtenPaths.length > 0) reportLines.push('', '**Status:** Task completed successfully.');
    } else if (iterationCount >= maxToolIterations) {
        reportLines.push('', '**Action required from you:**', `> The agent reached the iteration limit (${maxToolIterations}). Type **continue** to resume, or provide new instructions.`);
    }

    return reportLines.join('\n');
}