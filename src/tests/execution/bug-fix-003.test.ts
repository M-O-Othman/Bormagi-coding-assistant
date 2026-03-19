import { ExecutionStateManager, ExecutionStateData } from '../../agents/ExecutionStateManager';
import { BatchEnforcer } from '../../agents/execution/BatchEnforcer';
import { sanitiseCodeModeNarration } from '../../agents/execution/TranscriptSanitiser';
import * as fs from 'fs/promises';

jest.mock('fs/promises');

describe('Bug Fix 003 Validation Suite', () => {
    describe('1. ExecutionStateManager.computeDeterministicNextStep()', () => {
        let stateManager: ExecutionStateManager;

        beforeEach(() => {
            stateManager = new ExecutionStateManager('/mock/workspace');
        });

        it('returns declare_file_batch instruction for approved plan + greenfield + no batch', () => {
            const state: ExecutionStateData = stateManager.createFresh('agent-1', 'Build app', 'code');
            state.approvedPlanPath = '.bormagi/plans/app.md';
            state.artifactStatus = { '.bormagi/plans/app.md': 'approved' };
            state.plannedFileBatch = [];
            state.artifactsCreated = [];

            // Using 'greenfield_scaffold' which requires a batch
            state.taskTemplate = 'greenfield_scaffold';

            const result = stateManager.computeDeterministicNextStep(state);

            expect(result).not.toBeNull();
            expect(result?.nextAction).toContain('declare_file_batch');
            // Controller cannot guess files array, so nextToolCall shouldn't be fully direct-dispatched for this specific tool
            expect(result?.nextToolCall).toBeUndefined();
        });

        it('returns write_file(first pending) when batch exists', () => {
            const state: ExecutionStateData = stateManager.createFresh('agent-1', 'Build app', 'code');
            state.plannedFileBatch = ['src/index.ts', 'src/utils.ts'];
            state.completedBatchFiles = [];

            const result = stateManager.computeDeterministicNextStep(state);

            expect(result).not.toBeNull();
            expect(result?.nextAction).toContain('Write the next batch file now: src/index.ts');
            expect(result?.nextToolCall?.tool).toBe('write_file');
            expect((result?.nextToolCall?.input as any).path).toBe('src/index.ts');
        });

        it('returns deterministic non-read next action on repeated blocked reads', () => {
            const state: ExecutionStateData = stateManager.createFresh('agent-1', 'Build app', 'code');
            state.blockedReadCount = 3;
            state.artifactsCreated = ['src/old.ts'];

            const result = stateManager.computeDeterministicNextStep(state);

            expect(result).not.toBeNull();
            expect(result?.nextAction).toContain('Continue implementation — write or edit the next file');
        });
    });

    describe('2. BatchEnforcer.detectWorkspaceType()', () => {
        let batchEnforcer: BatchEnforcer;

        beforeEach(() => {
            batchEnforcer = new BatchEnforcer('/mock/workspace');
            jest.resetAllMocks();
        });

        it('classifies docs-only repo as docs_only (improving upon greenfield spec requirement)', async () => {
            // Mock readdir to return only docs and hidden folders, no package.json/src
            (fs.readdir as jest.Mock).mockImplementation(async (path, options) => {
                if (options?.withFileTypes) return [];
                return ['README.md', 'docs.txt', '.bormagi'];
            });
            (fs.access as jest.Mock).mockRejectedValue(new Error('not found'));

            const type = await batchEnforcer.detectWorkspaceType();
            expect(type).toBe('docs_only');
        });

        it('classifies package.json + <5 source files as scaffolded', async () => {
            (fs.readdir as jest.Mock).mockImplementation(async (path, options) => {
                if (options?.withFileTypes) {
                    return [{ name: 'index.ts', isDirectory: () => false }, { name: 'app.ts', isDirectory: () => false }];
                }
                return ['package.json'];
            });
            (fs.access as jest.Mock).mockImplementation(async (filePath: string) => {
                if (filePath.endsWith('package.json')) return;
                throw new Error('not found');
            });

            const type = await batchEnforcer.detectWorkspaceType();
            expect(type).toBe('scaffolded');
        });
    });

    describe('3. TranscriptSanitiser.sanitiseCodeModeNarration()', () => {
        it('removes repetitive code-mode filler', () => {
            const input = "I'll start by reading the plan document.\nThen I'll create the file.";
            const result = sanitiseCodeModeNarration(input);

            expect(result).not.toContain("I'll start by reading");
            expect(result).toContain("Then I'll create the file.");
        });

        it('preserves non-execution natural text and milestone summaries', () => {
            const input = "Progress checkpoint: completed 2 files.\nNext, we need to address the Redis connection.";
            const result = sanitiseCodeModeNarration(input);

            expect(result).toContain("Progress checkpoint");
            expect(result).toContain("Next, we need to address");
        });
    });
});