import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManager } from '../../../src/git/CheckpointManager';

describe('CheckpointManager', () => {
    let testCwd: string;
    let checkpointManager: CheckpointManager;

    beforeAll(() => {
        // Use os.tmpdir() to avoid EPERM cleanup failures on Windows.
        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-chkpt-test-'));

        // Setup a single small file in workspace
        fs.writeFileSync(path.join(testCwd, 'test.txt'), 'Hello World');

        checkpointManager = new CheckpointManager(testCwd);
    });

    afterAll(() => {
        if (fs.existsSync(testCwd)) {
            try {
                fs.rmSync(testCwd, { recursive: true, force: true });
            } catch {
                // Windows EPERM: git lock files may still be held
            }
        }
    });

    it('creates a shadow repository and tracking commit', async () => {
        const checkpoint = await checkpointManager.createCheckpoint('manual', 'Test Checkpoint');
        expect(checkpoint.id.startsWith('chk-')).toBe(true);
        expect(checkpoint.label).toBe('Test Checkpoint');

        // Verify shadow repo exists
        const shadowPath = path.join(testCwd, '.bormagi', 'shadow.git');
        expect(fs.existsSync(shadowPath)).toBe(true);
    }, 60000);

    it('restores the workspace correctly from a checkpoint', async () => {
        // 1. Snapshot
        const checkpoint = await checkpointManager.createCheckpoint('manual', 'Before Change');

        // 2. Modify file locally (Simulate AI failure)
        fs.writeFileSync(path.join(testCwd, 'test.txt'), 'BAD DATA');

        // 3. Restore
        await checkpointManager.restoreCheckpoint(checkpoint.id);

        // 4. Verify original state
        const content = fs.readFileSync(path.join(testCwd, 'test.txt'), 'utf8');
        expect(content).toBe('Hello World');
    }, 60000);

    it('returns a list of historically stored checkpoints', async () => {
        // Create checkpoints (may already have some from prior tests)
        await checkpointManager.createCheckpoint('manual', 'First');
        await checkpointManager.createCheckpoint('task_start', 'Second');

        const history = await checkpointManager.getHistory();
        expect(history.length).toBeGreaterThanOrEqual(2);

        const first = history.find(c => c.label === 'First');
        expect(first).toBeDefined();
        expect(first?.trigger).toBe('manual');

        const second = history.find(c => c.label === 'Second');
        expect(second).toBeDefined();
        expect(second?.trigger).toBe('task_start');
    }, 60000);
});
