import * as fs from 'fs';
import * as path from 'path';
import { PolicyEngine } from '../../sandbox/PolicyEngine';

describe('PolicyEngine Unit Tests', () => {
    let workspaceRoot: string;
    let bormagiDir: string;
    let policyDir: string;
    let engine: PolicyEngine;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(process.cwd(), 'policy-test-'));
        bormagiDir = path.join(workspaceRoot, '.bormagi');
        policyDir = path.join(bormagiDir, 'policies');
        fs.mkdirSync(policyDir, { recursive: true });

        // Let the engine create the default policy
        engine = new PolicyEngine(workspaceRoot);
    });

    afterEach(() => {
        if (fs.existsSync(workspaceRoot)) {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('denies high risk commands natively', async () => {
        const res = await engine.evaluate({
            actionKind: 'exec_command',
            command: 'sudo rm -rf /',
            taskId: 'test',
            repoId: 'test',
            userId: 'user',
            isolationMode: 'test'
        });
        expect(res.decision).toBe('deny');
        expect(res.requiresApproval).toBe(true);
    });

    it('allows implicitly safe tools like read_file', async () => {
        const res = await engine.evaluate({
            actionKind: 'read_file',
            path: 'src/main.ts',
            taskId: 'test',
            repoId: 'test',
            userId: 'user',
            isolationMode: 'test'
        });
        expect(res.decision).toBe('allow');
    });

    it('asks for user approval on write_file by default', async () => {
        const res = await engine.evaluate({
            actionKind: 'write_file',
            path: 'src/main.ts',
            taskId: 'test',
            repoId: 'test',
            userId: 'user',
            isolationMode: 'test'
        });
        expect(res.decision).toBe('ask');
        expect(res.requiresApproval).toBe(true);
    });

    it('allows git status from default command policy', async () => {
        const res = await engine.evaluate({
            actionKind: 'exec_command',
            command: 'git status',
            taskId: 'test',
            repoId: 'test',
            userId: 'user',
            isolationMode: 'test'
        });
        expect(res.decision).toBe('allow');
        expect(res.requiresApproval).toBe(false);
    });
});
