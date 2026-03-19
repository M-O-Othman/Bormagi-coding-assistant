export interface ToolLedgerEntry {
    turn: number;
    tool: string;
    path?: string;
    status: 'success' | 'error' | 'blocked';
    summary: string;
}

export interface SessionLedger {
    entries: ToolLedgerEntry[];
}

export function collectChangedFiles(entries: ToolLedgerEntry[]): string[] {
    return [...new Set(
        entries
            .filter(e => e.tool === 'write_file' || e.tool === 'edit_file' || e.tool === 'replace_range' || e.tool === 'multi_edit')
            .filter(e => e.status === 'success' && !!e.path)
            .map(e => e.path as string)
    )];
}

export function collectReadFiles(entries: ToolLedgerEntry[]): string[] {
    return [...new Set(
        entries
            .filter(e => e.tool === 'read_file' || e.tool === 'list_files' || e.tool === 'read_file_range' || e.tool === 'read_symbol_block')
            .filter(e => e.status === 'success' && !!e.path)
            .map(e => e.path as string)
    )];
}