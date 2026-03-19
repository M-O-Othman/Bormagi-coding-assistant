import { SessionLedger, collectChangedFiles } from './SessionLedger';

export function renderSessionSummary(ledger: SessionLedger): string {
    const changedFiles = collectChangedFiles(ledger.entries);
    const toolCount = ledger.entries.length;

    const changedBlock = changedFiles.length
        ? changedFiles.map(f => `- ${f}`).join('\n')
        : '- none';

    return [
        'Session Report',
        '',
        'Changed Files',
        changedBlock,
        '',
        `Tool operations: ${toolCount}`,
    ].join('\n');
}

export function assertSummaryConsistency(ledger: SessionLedger, summaryFiles: string[]): void {
    const actual = new Set(collectChangedFiles(ledger.entries));
    const claimed = new Set(summaryFiles);

    for (const file of claimed) {
        if (!actual.has(file)) {
            throw new Error(`Summary claimed changed file not in ledger: ${file}`);
        }
    }
}