export function classifyAndAdaptError(toolName: string, input: Record<string, unknown>, dispatchResultText: string, execState?: Record<string, any>): string {
    // 1. Contract-violation / Duplicate Edit
    // If the agent aggressively tries to recreate a file that already exists and gets a block, redirect it.
    if (dispatchResultText.includes('File already exists') || dispatchResultText.includes('already written') || dispatchResultText.includes('ALREADY READ')) {
        if (execState) {
             const path = String(input.path || '');
             execState.nextActions = [`Use edit_file or replace_range for ${path}`];
        }
        return `${dispatchResultText}\n\n[REMEDIATION] You are trying to overwrite/reread a file that already exists or was already addressed. Do not retry write_file or read_file for this path. Use \`edit_file\` or \`replace_range\` to modify the existing file.`;
    }

    // 2. Environment / OS Syntax issues
    // For Windows 'mkdir -p' or generic blocked commands
    if (toolName === 'run_command') {
        const cmd = String(input.command || '');
        if (dispatchResultText.includes('not available on this Windows host') || dispatchResultText.includes('Unix command syntax')) {
            if (cmd.includes('mkdir')) {
                if (execState) execState.nextActions = ['Use FsOps.ensureDir or standard Windows cmd for directory creation'];
                return `${dispatchResultText}\n\n[REMEDIATION] Syntax error or blocked. Do not retry \`mkdir -p\`. Use the built-in file writing tools (which auto-create directories) or use standard Windows cmd syntax (e.g., \`mkdir\` without \`-p\`).`;
            }
            if (execState) execState.nextActions = [`Use equivalent Windows command for ${cmd}`];
            return `${dispatchResultText}\n\n[REMEDIATION] You attempted a Unix command on a Windows host. Do not retry this command. Use the relevant Windows cmd equivalent.`;
        }
    }

    // 3. Logic / WRITE_ONLY constraints
    if (dispatchResultText.includes('WRITE_ONLY')) {
        return `${dispatchResultText}\n\n[REMEDIATION] You are stuck in a read-loop. The system has hard-locked you into a WRITE_ONLY phase. Stop reading files. You MUST call \`write_file\`, \`edit_file\`, or \`run_command\` next.`;
    }
    
    // 4. Budget constraints
    if (dispatchResultText.includes('DISCOVERY_BUDGET_EXHAUSTED') || dispatchResultText.includes('DISCOVERY LOCKED')) {
        return `${dispatchResultText}\n\n[REMEDIATION] Discovery budget exhausted. You are reading too much without making material progress. You MUST write or edit a file before doing any further discovery.`;
    }

    return dispatchResultText;
}
