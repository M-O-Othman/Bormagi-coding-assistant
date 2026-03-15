import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { GitService } from '../../../src/git/GitService';

describe('GitService', () => {
    let testCwd: string;
    let gitService: GitService;

    beforeAll(() => {
        // Use os.tmpdir() to avoid creating temp repos inside the project workspace
        // which causes slow git operations and EPERM cleanup failures on Windows.
        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-git-test-'));

        // Setup mock files in workspace
        fs.writeFileSync(path.join(testCwd, 'test.txt'), 'Hello World');

        // Initialize an empty Git repository synchronously
        execSync('git init', { cwd: testCwd, stdio: 'pipe' });
        execSync('git add .', { cwd: testCwd, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "Initial commit"', { cwd: testCwd, stdio: 'pipe' });

        gitService = new GitService(testCwd);
    });

    afterAll(() => {
        if (fs.existsSync(testCwd)) {
            try {
                fs.rmSync(testCwd, { recursive: true, force: true });
            } catch {
                // Windows EPERM: git lock files may still be held — best effort cleanup
            }
        }
    });

    it('discovers repository capabilities correctly for an existing repo', async () => {
        const capabilities = await gitService.discoverRepo(testCwd);
        expect(capabilities.isGitRepo).toBe(true);
        // Normalize both paths for cross-platform comparison
        expect(path.normalize(capabilities.rootPath)).toBe(path.normalize(testCwd));
        // Git default branch may be master or main depending on config
        expect(['master', 'main']).toContain(capabilities.headRef);
    }, 15000);

    it('correctly reports no capabilities for a non-git directory', async () => {
        const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-non-git-'));
        try {
            const capabilities = await gitService.discoverRepo(nonGitDir);
            expect(capabilities.isGitRepo).toBe(false);
        } finally {
            try {
                fs.rmSync(nonGitDir, { recursive: true, force: true });
            } catch {
                // best effort cleanup
            }
        }
    }, 15000);

    it('can retrieve empty diffs', async () => {
        const diff = await gitService.getDiff(testCwd);
        expect(diff).toBe('');
    }, 30000);

    it('correctly ingests working tree status as clean', async () => {
        // Ensure all files are committed so status is clean
        try {
            execSync('git add -A && git commit -m "commit all" --allow-empty', { cwd: testCwd, stdio: 'pipe' });
        } catch {
            // already clean
        }
        const status = await gitService.getStatus(testCwd);
        expect(status.state).toBe('clean');
        expect(status.changedPaths).toHaveLength(0);
    }, 30000);
});
