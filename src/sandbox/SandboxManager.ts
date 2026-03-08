import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SandboxCreateRequest, SandboxHandle, SandboxManifest } from './types';

const execAsync = promisify(exec);

export class SandboxManager {
    private readonly sandboxRoot: string;
    private readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.sandboxRoot = path.join(workspaceRoot, '.bormagi', 'sandboxes');
        if (!fs.existsSync(this.sandboxRoot)) {
            fs.mkdirSync(this.sandboxRoot, { recursive: true });
        }
    }

    public async create(req: SandboxCreateRequest): Promise<SandboxHandle> {
        const uniqueId = `sbx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const sandboxDir = path.join(this.sandboxRoot, uniqueId);
        const workspacePath = path.join(sandboxDir, 'workspace');
        const manifestPath = path.join(sandboxDir, 'manifest.json');

        fs.mkdirSync(sandboxDir, { recursive: true });

        const isGitRepo = fs.existsSync(path.join(this.workspaceRoot, '.git'));

        // Normalise taskId: strip any leading "task-" so the branch never
        // becomes "bormagi/task-task-<id>" when the caller already prefixes it.
        const normTaskId = req.taskId.replace(/^task-/, '');
        let branchName = `bormagi/task-${normTaskId}`;

        if (isGitRepo && req.isolationMode === 'local_worktree_sandbox') {
            try {
                // Determine base ref if not provided
                let base = req.baseRef;
                if (!base) {
                    const { stdout: currentBranch } = await execAsync(`git rev-parse --abbrev-ref HEAD`, { cwd: this.workspaceRoot });
                    base = currentBranch.trim();
                }

                // Create branch if not exists
                try {
                    await execAsync(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd: this.workspaceRoot });
                } catch {
                    // Create unlinked branch
                    await execAsync(`git branch ${branchName} ${base}`, { cwd: this.workspaceRoot });
                }

                // Create worktree
                await execAsync(`git worktree add ${workspacePath} ${branchName}`, { cwd: this.workspaceRoot });

            } catch (err: any) {
                console.warn(`Git worktree creation failed. Falling back to copy. Reason: ${err.message}`);
                await this.copyFallback(workspacePath);
            }
        } else {
            // Fallback for non-git or different modes
            await this.copyFallback(workspacePath);
        }

        const manifest: SandboxManifest = {
            sandboxId: uniqueId,
            taskId: req.taskId,
            createdAt: new Date().toISOString(),
            sourceRepo: this.workspaceRoot,
            baseRef: req.baseRef || 'HEAD',
            workspacePath,
            isolationMode: req.isolationMode,
            policyBundleId: req.policyBundleId,
            status: 'running'
        };

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        return {
            sandboxId: uniqueId,
            workspacePath,
            manifestPath,
            checkpointDir: path.join(sandboxDir, 'checkpoints')
        };
    }

    private async copyFallback(destPath: string) {
        // Exclude .git, node_modules, .bormagi to save time
        const excludes = ['.git', 'node_modules', '.bormagi'];

        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }

        const items = fs.readdirSync(this.workspaceRoot);
        for (const item of items) {
            if (excludes.includes(item)) continue;

            const src = path.join(this.workspaceRoot, item);
            const dest = path.join(destPath, item);

            // Simple recursive copy using cross-platform Node.js API
            fs.cpSync(src, dest, { recursive: true });
        }
    }

    public async destroy(sandboxId: string): Promise<void> {
        const sandboxDir = path.join(this.sandboxRoot, sandboxId);
        if (!fs.existsSync(sandboxDir)) return;

        const manifestPath = path.join(sandboxDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            const manifest: SandboxManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            manifest.status = 'destroyed';
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }

        const workspacePath = path.join(sandboxDir, 'workspace');
        if (fs.existsSync(path.join(workspacePath, '.git'))) {
            // It's a worktree
            try {
                await execAsync(`git worktree remove --force ${workspacePath}`, { cwd: this.workspaceRoot });
            } catch (err) {
                console.error(`Failed to remove worktree: ${err}`);
            }
        }

        // Wipe director
        fs.rmSync(sandboxDir, { recursive: true, force: true });
    }

    public async promote(sandboxId: string): Promise<void> {
        const sandboxDir = path.join(this.sandboxRoot, sandboxId);
        if (!fs.existsSync(sandboxDir)) throw new Error('Sandbox not found');

        const workspacePath = path.join(sandboxDir, 'workspace');
        if (!fs.existsSync(workspacePath)) throw new Error('Sandbox workspace missing');

        const excludes = ['.git', 'node_modules', '.bormagi'];
        const items = fs.readdirSync(workspacePath);
        for (const item of items) {
            if (excludes.includes(item)) continue;

            const src = path.join(workspacePath, item);
            const dest = path.join(this.workspaceRoot, item);

            // Promote back to host by overwriting files
            // This leaves the changes unstaged in the host's Git SCM for the user to review natively.
            fs.cpSync(src, dest, { recursive: true, force: true });
        }
    }
}
