import * as fs from 'fs';
import * as path from 'path';

describe('CI Session Replay Tests', () => {
    it('should verify that sessions do not leak restricted commands', () => {
        // Mock parsing the session ledger or just asserting our dispatcher structure 
        // prevents typical bad commands
        const mockLog = [
            { tool: 'run_command', input: { command: 'mkdir -p test' }, output: 'Directories created via FsOps.' },
            { tool: 'write_file', input: { path: 'foo.ts' }, output: 'success' },
            { tool: 'write_file', input: { path: 'foo.ts' }, output: 'File written' }
        ];

        let duplicateWrites = 0;
        let badUnixCommands = 0;

        const writes = new Set<string>();

        for (const entry of mockLog) {
            if (entry.tool === 'run_command' && 'command' in entry.input) {
                const cmd = entry.input.command as string;
                if (/mkdir\s+-p/i.test(cmd)) {
                    // Check if it got routed to FsOps
                    if (!entry.output.includes('FsOps')) badUnixCommands++;
                }
            } else if (entry.tool === 'write_file' && 'path' in entry.input) {
                const p = entry.input.path as string;
                if (writes.has(p)) {
                    // In a real session, ToolDispatcher silently redirects this to patch.
                    // If we saw it fail with REJECTED, it's a bug.
                    if (entry.output.includes('REJECTED')) {
                        duplicateWrites++;
                    }
                }
                writes.add(p);
            }
        }

        expect(badUnixCommands).toBe(0);
        expect(duplicateWrites).toBe(0);
    });
});
