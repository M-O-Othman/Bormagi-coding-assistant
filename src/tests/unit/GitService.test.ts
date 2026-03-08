import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GitService } from '../../../src/git/GitService';

const execAsync = promisify(exec);

describe('GitService', () => {
    let testCwd: string;
    let gitService: GitService;

    beforeAll(async () => {
        // Create an isolated test directory
        testCwd = path.join(__dirname, 'test-git-repo-' + Date.now());
        fs.mkdirSync(testCwd, { recursive: true });

        // Initialize an empty Git repository
        await execAsync(`git init`, { cwd: testCwd });
        await execAsync(`git commit --allow-empty -m "Initial commit"`, { cwd: testCwd });

        gitService = new GitService(testCwd);
    });

    afterAll(() => {
        // Cleanup test directory
        if (fs.existsSync(testCwd)) {
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });

    it('discovers repository capabilities correctly for an existing repo', async () => {
        const capabilities = await gitService.discoverRepo(testCwd);
        expect(capabilities.isGitRepo).toBe(true);
        expect(capabilities.rootPath).toBe(testCwd);
        expect(capabilities.headRef).toBe('master'); // or main depending on git config, usually master by default in tests
    });

    it('correctly reports no capabilities for a non-git directory', async () => {
        // To prevent git from finding the overarching bormagi-extension repo, 
        // we must create a temp dir outside of the current workspace root.
        const nonGitDir = fs.mkdtempSync(path.join(process.cwd(), '..', 'non-git-dir-'));

        try {
            const capabilities = await gitService.discoverRepo(nonGitDir);
            expect(capabilities.isGitRepo).toBe(false);
        } finally {
            fs.rmSync(nonGitDir, { recursive: true, force: true });
        }
    });

    it('can retrieve empty diffs', async () => {
        const diff = await gitService.getDiff(testCwd);
        expect(diff).toBe('');
    });

    it('correctly ingests working tree status as clean', async () => {
        const status = await gitService.getStatus(testCwd);
        expect(status.state).toBe('clean');
        expect(status.changedPaths).toHaveLength(0);
    });
});
