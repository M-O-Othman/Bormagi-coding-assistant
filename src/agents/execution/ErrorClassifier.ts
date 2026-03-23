export enum ErrKind {
    Env = 'Env',
    Contract = 'Contract',
    Duplicate = 'Duplicate',
    Unknown = 'Unknown'
}

export function classifyError(dispatchResultText: string): ErrKind {
    if (dispatchResultText.includes('File already exists') || dispatchResultText.includes('already written')) return ErrKind.Duplicate;
    if (dispatchResultText.includes('not available on this Windows host') || dispatchResultText.includes('Unix command syntax')) return ErrKind.Env;
    if (dispatchResultText.includes('Missing project spec') || dispatchResultText.includes('Contract')) return ErrKind.Contract;
    return ErrKind.Unknown;
}

export function classifyAndAdaptError(toolName: string, input: Record<string, unknown>, dispatchResultText: string, execState?: Record<string, any>): string {
    const kind = classifyError(dispatchResultText);

    if (kind === ErrKind.Duplicate) {
        if (execState) {
             const path = String(input.path || '');
             execState.nextActions = [`Use edit_file or replace_range for ${path}`];
        }
        return `${dispatchResultText}\n\n[REMEDIATION] Duplicate detected. Auto-converting to patch operation. Request edit_file to proceed.`;
    }

    if (kind === ErrKind.Env) {
        const cmd = String(input.command || '');
        if (cmd.includes('mkdir') && execState) execState.nextActions = ['Use FsOps.ensureDir or standard Windows cmd for directory creation'];
        if (execState && !cmd.includes('mkdir')) execState.nextActions = [`Use equivalent Windows command for ${cmd}`];
        return `${dispatchResultText}\n\n[REMEDIATION] Env mismatch. Route through SemanticGateway safeExec or ensureDir fallback.`;
    }

    if (kind === ErrKind.Contract) {
         if (execState) execState.nextActions = ['Halt. Missing project contract.'];
         return `${dispatchResultText}\n\n[FATAL] Missing bormagi.project.json contract. Execution halted.`;
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
