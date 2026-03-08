import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { Checkpoint } from './GitService';

const execAsync = promisify(exec);

export class CheckpointManager {
    constructor(private workspaceRoot: string) { }

    private get shadowRepoPath(): string {
        return path.join(this.workspaceRoot, '.bormagi', 'shadow.git');
    }

    /** Ensure the shadow tracking repository exists */
    private async initShadowRepo(): Promise<void> {
        const shadowPath = this.shadowRepoPath;
        if (!fs.existsSync(shadowPath)) {
            fs.mkdirSync(shadowPath, { recursive: true });
            await execAsync(`git init`, { cwd: shadowPath });
            // Initial empty commit to establish HEAD
            await execAsync(`git commit --allow-empty -m "Initial Shadow Checkpoint"`, { cwd: shadowPath });
        }
    }

    /** Sync current workspace files to the shadow repo and create a checkpoint commit */
    public async createCheckpoint(trigger: Checkpoint['trigger'], label: string): Promise<Checkpoint> {
        await this.initShadowRepo();
        const shadowPath = this.shadowRepoPath;
        const checkpointId = `chk-${Date.now()}`;

        // Exclude node_modules, .git, and .bormagi from being copied
        // using rsync equivalent for node
        const excludes = ['.git', 'node_modules', '.bormagi'];
        const items = fs.readdirSync(this.workspaceRoot);
        for (const item of items) {
            if (excludes.includes(item)) continue;
            const src = path.join(this.workspaceRoot, item);
            const dest = path.join(shadowPath, item);
            fs.cpSync(src, dest, { recursive: true, force: true });
        }

        // Commit in shadow repo
        const msg = `[${trigger}] ${label} (${checkpointId})`;
        await execAsync(`git add -A`, { cwd: shadowPath });

        let commitHash = '';
        try {
            // Need to allow-empty in case the snapshot hasn't changed since last checkpoint
            const { stdout } = await execAsync(`git commit --allow-empty -m "${msg}"`, { cwd: shadowPath });
            // Extract commit hash via log instead of parsing brittle commit output
            const { stdout: logOut } = await execAsync(`git log -1 --format="%H"`, { cwd: shadowPath });
            commitHash = logOut.trim();
        } catch (e) {
            console.warn('Silent failure on shadow commit:', e);
            commitHash = 'no-changes';
        }

        return {
            id: checkpointId,
            repoRoot: this.workspaceRoot,
            createdAt: new Date().toISOString(),
            trigger,
            storageMode: 'shadow',
            label,
            affectedPaths: [] // Can be parsed from git show if needed
        };
    }

    /** Sync files BACK to workspace */
    public async restoreCheckpoint(checkpointId: string): Promise<void> {
        const shadowPath = this.shadowRepoPath;
        if (!fs.existsSync(shadowPath)) throw new Error('No shadow repository found.');

        // Find the commit in shadow repo with the matching checkpointId
        const { stdout: logOut } = await execAsync(`git log --grep="(${checkpointId})" --format="%H"`, { cwd: shadowPath });
        const commitHash = logOut.trim().split('\n')[0];
        if (!commitHash) throw new Error(`Checkpoint ${checkpointId} not found.`);

        // Hard reset the shadow repo to that state
        await execAsync(`git reset --hard ${commitHash}`, { cwd: shadowPath });

        // Sync files BACK to workspace
        const excludes = ['.git'];
        const items = fs.readdirSync(shadowPath);
        for (const item of items) {
            if (excludes.includes(item)) continue;
            const src = path.join(shadowPath, item);
            const dest = path.join(this.workspaceRoot, item);
            fs.cpSync(src, dest, { recursive: true, force: true });
        }
    }

    /** Returns all checkpoints stored in the shadow repo */
    public async getHistory(): Promise<Checkpoint[]> {
        const shadowPath = this.shadowRepoPath;
        if (!fs.existsSync(shadowPath)) return [];

        try {
            // Format: %H|%ct|%s
            // %H: commit hash
            // %ct: committer date, UNIX timestamp
            // %s: subject
            const { stdout } = await execAsync(`git log --format="%H|%ct|%s"`, { cwd: shadowPath });
            const lines = stdout.trim().split('\n');

            return lines.map(line => {
                const [hash, timestamp, subject] = line.split('|');
                const idMatch = subject.match(/\((chk-\d+)\)/);
                const triggerMatch = subject.match(/^\[(.*?)\]/);

                return {
                    id: idMatch ? idMatch[1] : hash.substring(0, 8),
                    repoRoot: this.workspaceRoot,
                    createdAt: new Date(parseInt(timestamp, 10) * 1000).toISOString(),
                    trigger: (triggerMatch ? triggerMatch[1] : 'unknown') as any,
                    storageMode: 'shadow' as 'shadow',
                    label: subject.replace(/^\[.*?\]\s*/, '').replace(/\s*\(chk-\d+\)$/, ''),
                    affectedPaths: []
                };
            }).filter(c => c.label !== 'Initial Shadow Checkpoint');
        } catch (err) {
            console.error('Failed to fetch checkpoint history:', err);
            return [];
        }
    }
}
