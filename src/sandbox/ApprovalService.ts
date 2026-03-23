import * as path from 'path';
import * as fs from 'fs';
import { ApprovalDecision, ActionKind, ApprovalScope } from './types';
import { getAppData } from '../data/DataStore';

export class ApprovalService {
    private readonly workspaceRoot: string;
    private readonly cachePath: string;
    private scopedApprovals: ApprovalDecision[] = [];

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.cachePath = path.join(this.workspaceRoot, '.bormagi', 'approvals.json');
        this.loadApprovals();
    }

    private loadApprovals() {
        if (fs.existsSync(this.cachePath)) {
            try {
                this.scopedApprovals = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
                // Evict expired
                this.scopedApprovals = this.scopedApprovals.filter(a => {
                    if (a.expiresAt && new Date(a.expiresAt) < new Date()) return false;
                    return true;
                });
                this.saveApprovals(); // Save clean list
            } catch {
                this.scopedApprovals = [];
            }
        }
    }

    private saveApprovals() {
        try {
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.cachePath, JSON.stringify(this.scopedApprovals, null, 2));
        } catch (err) {
            console.error('Failed to save approvals cache', err);
        }
    }

    private matchesApprovalPattern(storedMatcher: string, incomingCommand: string): boolean {
        // Exact match
        if (storedMatcher === incomingCommand) return true;
        // Wildcard project approvals
        if (storedMatcher === '*') return true;
        // Glob-style prefix match: "mkdir *" covers "mkdir sourcedocs", "mkdir foo/bar"
        if (storedMatcher.endsWith(' *')) {
            const prefix = storedMatcher.slice(0, -2); // strip ' *'
            if (incomingCommand.startsWith(prefix + ' ') || incomingCommand === prefix) return true;
        }
        // Glob-style wildcard anywhere: convert simple '*' to regex
        if (storedMatcher.includes('*')) {
            const escaped = storedMatcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`).test(incomingCommand);
        }
        return false;
    }

    public checkPriorApproval(actionKind: ActionKind, matcher: string, taskId?: string): boolean {
        return this.scopedApprovals.some(approval => {
            if (!approval.allow) return false;
            if (approval.actionKind !== actionKind) return false;
            if (!this.matchesApprovalPattern(approval.matcher, matcher)) return false;

            // If scoped to a task, only works if this is the task
            if (approval.scope === 'task' && approval.reason !== taskId) return false;

            return true;
        });
    }

    public recordApproval(decision: Omit<ApprovalDecision, 'createdAt' | 'createdBy'>) {
        if (decision.scope === 'once') return; // Do not record 1-time throwaways

        this.scopedApprovals.push({
            ...decision,
            createdAt: new Date().toISOString(),
            createdBy: 'user'
        });

        this.saveApprovals();
    }
}
