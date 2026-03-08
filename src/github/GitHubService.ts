import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PRDetails {
    title: string;
    body: string;
    head: string;
    base: string;
    isDraft: boolean;
}

export interface CheckRunResult {
    name: string;
    status: string;
    conclusion: string;
    detailsUrl: string;
}

export class GitHubService {
    constructor(private readonly workspaceRoot: string) { }

    /**
     * Attempts to get a GitHub access token.
     * Tries VS Code's native authentication first, falling back to checking if the gh cli is authenticated.
     */
    public async getAuthToken(): Promise<string | null> {
        try {
            // Priority 1: VS Code Native Auth
            const session = await vscode.authentication.getSession('github', ['repo', 'workflow'], { createIfNone: false });
            if (session?.accessToken) {
                return session.accessToken;
            }
        } catch (e) {
            console.log('VS Code GitHub Auth unavailable or declined:', e);
        }

        try {
            // Priority 2: GitHub CLI (fallback)
            const { stdout } = await execAsync('gh auth token');
            return stdout.trim();
        } catch (e) {
            console.log('GitHub CLI Auth unavailable:', e);
            return null;
        }
    }

    /**
     * Creates a Pull Request draft automatically using the GH CLI.
     * We use the CLI here because it handles remote tracking branch setup natively and handles forks well.
     */
    public async createPullRequest(params: PRDetails): Promise<{ url: string, number: number }> {
        // Escape quotes to prevent injection
        const safeTitle = params.title.replace(/"/g, '\\"');
        const safeBody = params.body.replace(/"/g, '\\"');

        let cmd = `gh pr create --title "${safeTitle}" --body "${safeBody}" --head ${params.head} --base ${params.base}`;
        if (params.isDraft) {
            cmd += ' --draft';
        }

        try {
            const { stdout } = await execAsync(cmd, { cwd: this.workspaceRoot });
            const url = stdout.trim();
            const numberMatch = url.match(/\/pull\/(\d+)$/);
            return {
                url,
                number: numberMatch ? parseInt(numberMatch[1], 10) : -1
            };
        } catch (err: any) {
            throw new Error(`Failed to create PR: ${err.message}`);
        }
    }

    /**
     * Fetches the current Check Runs (CI status) for a specific PR.
     */
    public async getPRCheckRuns(prNumber: number): Promise<CheckRunResult[]> {
        try {
            const { stdout } = await execAsync(`gh pr checks ${prNumber} --json name,state,conclusion,link`, { cwd: this.workspaceRoot });
            const rawChecks = JSON.parse(stdout);
            return rawChecks.map((c: any) => ({
                name: c.name,
                status: c.state,
                conclusion: c.conclusion,
                detailsUrl: c.link
            }));
        } catch (err: any) {
            // Wait state or no checks yet
            console.log(`Failed to fetch checks for PR #${prNumber}:`, err.message);
            return [];
        }
    }

    /**
     * Fetches review thread comments from a Pull Request.
     */
    public async getPRReviewComments(prNumber: number): Promise<any[]> {
        try {
            // Using gh api to fetch review comments
            const { stdout } = await execAsync(`gh api repos/{owner}/{repo}/pulls/${prNumber}/comments`, { cwd: this.workspaceRoot });
            return JSON.parse(stdout);
        } catch (err: any) {
            throw new Error(`Failed to fetch review comments: ${err.message}`);
        }
    }

    /**
     * Pushes current changes to the upstream branch of the PR.
     */
    public async pushToPR(prNumber: number): Promise<void> {
        try {
            await execAsync(`gh pr checkout ${prNumber}`, { cwd: this.workspaceRoot });
            await execAsync(`git push`, { cwd: this.workspaceRoot });
        } catch (err: any) {
            throw new Error(`Failed to push changes to PR #${prNumber}: ${err.message}`);
        }
    }
}
