import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export type WorkingTreeState =
    | "clean"
    | "dirty-user-only"
    | "dirty-assistant-only"
    | "mixed"
    | "conflicted";

export interface RepoCapabilities {
    isGitRepo: boolean;
    rootPath: string;
    headRef: string | null;
    isDetachedHead: boolean;
    isWorktree: boolean;
    hasGitHubRemote: boolean;
    remotes: Array<{ name: string; url: string }>;
    canCommit: boolean;
    canCreateBranch: boolean;
    canPush: boolean;
    canOpenPullRequest: boolean;
    sandboxAllowsGitWrite: boolean;
}

export interface ChangedPath {
    path: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    conflicted: boolean;
}

export interface RepoStatusSnapshot {
    repoRoot: string;
    headRef: string | null;
    baseRef?: string | null;
    ahead?: number;
    behind?: number;
    changedPaths: ChangedPath[];
    state: WorkingTreeState;
    hasGitHubRemote: boolean;
    capturedAt: string;
}

export interface Checkpoint {
    id: string;
    repoRoot: string;
    createdAt: string;
    trigger: "task_start" | "before_edit" | "before_command" | "manual";
    storageMode: "shadow" | "main-repo";
    label: string;
    affectedPaths: string[];
}

export class GitService {

    constructor(private defaultCwd: string) { }

    /** FR-001/002/004: Repository discovery and root detection */
    public async discoverRepo(cwd: string = this.defaultCwd): Promise<RepoCapabilities> {
        try {
            const { stdout: rootOut } = await execAsync(`git rev-parse --show-toplevel`, { cwd });
            // Normalize slashes for Windows compatibility
            const rootPath = path.normalize(rootOut.trim());
            const normalizedCwd = path.normalize(cwd);

            const isDetachedHead = await execAsync(`git branch --show-current`, { cwd }).then(
                (res) => !res.stdout.trim(),
                () => true
            );

            let headRef: string | null = null;
            if (!isDetachedHead) {
                const { stdout: branchOut } = await execAsync(`git branch --show-current`, { cwd });
                headRef = branchOut.trim();
            } else {
                const { stdout: hashOut } = await execAsync(`git rev-parse HEAD`, { cwd }).catch(() => ({ stdout: '' }));
                headRef = hashOut.trim() || null;
            }

            const isWorktree = await execAsync(`git rev-parse --is-inside-work-tree`, { cwd }).then(
                (res) => res.stdout.trim() === 'true',
                () => false
            );

            const { stdout: remotesOut } = await execAsync(`git remote -v`, { cwd }).catch(() => ({ stdout: '' }));
            const remotesLines = remotesOut.trim().split('\n').filter(Boolean);
            const remotes: Array<{ name: string; url: string }> = [];
            let hasGitHubRemote = false;

            remotesLines.forEach(line => {
                const parts = line.split(/[\s\t]+/);
                if (parts.length >= 2) {
                    const [name, url] = parts;
                    // Prevent duplicates (fetch vs push)
                    if (!remotes.find(r => r.name === name)) {
                        remotes.push({ name, url });
                        if (url.includes('github.com')) hasGitHubRemote = true;
                    }
                }
            });

            return {
                isGitRepo: true,
                rootPath,
                headRef,
                isDetachedHead,
                isWorktree,
                hasGitHubRemote,
                remotes,
                canCommit: true,
                canCreateBranch: true,
                canPush: remotes.length > 0,
                canOpenPullRequest: hasGitHubRemote,
                sandboxAllowsGitWrite: true
            };

        } catch (error) {
            return {
                isGitRepo: false,
                rootPath: cwd,
                headRef: null,
                isDetachedHead: false,
                isWorktree: false,
                hasGitHubRemote: false,
                remotes: [],
                canCommit: false,
                canCreateBranch: false,
                canPush: false,
                canOpenPullRequest: false,
                sandboxAllowsGitWrite: false
            };
        }
    }

    /** FR-006: Working tree status ingestion */
    public async getStatus(repoRoot: string): Promise<RepoStatusSnapshot> {
        const capabilities = await this.discoverRepo(repoRoot);

        let statusOut = '';
        let hasConflict = false;
        try {
            const { stdout } = await execAsync(`git status --porcelain`, { cwd: repoRoot });
            statusOut = stdout;
        } catch (e) {
            // Might be an uninitialized repo
        }

        const lines = statusOut.split('\n').filter(l => l.length > 0);
        const changedPaths: ChangedPath[] = [];

        for (const line of lines) {
            const X = line[0];
            const Y = line[1];
            const pathInfo = line.substring(3).trim();

            const isUnmerged = (X === 'U' || Y === 'U' || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D'));
            if (isUnmerged) hasConflict = true;

            const staged = (X !== ' ' && X !== '?' && X !== 'U');
            const unstaged = (Y !== ' ' && Y !== '?' && Y !== 'U');
            const untracked = (X === '?' && Y === '?');

            changedPaths.push({
                path: pathInfo,
                staged,
                unstaged,
                untracked,
                conflicted: isUnmerged
            });
        }

        // Simplistic inference of state (We'll assume 'dirty-user-only' if dirty since assistant hasn't tracked its own changes cleanly yet in vanilla files)
        let state: WorkingTreeState = "clean";
        if (hasConflict) state = "conflicted";
        else if (changedPaths.length > 0) state = "dirty-user-only";

        return {
            repoRoot,
            headRef: capabilities.headRef,
            changedPaths,
            state,
            hasGitHubRemote: capabilities.hasGitHubRemote,
            capturedAt: new Date().toISOString()
        };
    }

    /** View diffs (FR-008) */
    public async getDiff(repoRoot: string, opts?: { staged?: boolean; baseRef?: string }): Promise<string> {
        let cmd = `git diff`;
        if (opts?.staged) cmd += ` --staged`;
        if (opts?.baseRef) cmd += ` ${opts.baseRef}...HEAD`;

        try {
            const { stdout } = await execAsync(cmd, { cwd: repoRoot });
            return stdout;
        } catch {
            return '';
        }
    }
}
