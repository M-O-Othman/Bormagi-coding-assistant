import { ActionKind, ApprovalScope } from './types';

interface ApprovalDecision {
    actionKind: ActionKind;
    matcher: string;
    scope: ApprovalScope;
    allow: boolean;
    createdAt: string;
    expiresAt?: string;
}

export class ApprovalService {
    private savedApprovals: ApprovalDecision[] = [];

    constructor() { }

    async checkPreApproved(taskId: string, kind: ActionKind, matcher: string): Promise<boolean> {
        const now = new Date();
        const approval = this.savedApprovals.find(a =>
            a.actionKind === kind &&
            a.matcher === matcher &&
            a.allow === true &&
            (!a.expiresAt || new Date(a.expiresAt) > now)
        );
        return !!approval;
    }

    async recordApproval(kind: ActionKind, matcher: string, scope: ApprovalScope, allow: boolean): Promise<void> {
        if (scope === 'once') return; // Do not persist transient approvals

        this.savedApprovals.push({
            actionKind: kind,
            matcher,
            scope,
            allow,
            createdAt: new Date().toISOString(),
            // Auto-expire task-scoped approvals after 24 hours
            expiresAt: scope === 'task' ? new Date(Date.now() + 86400000).toISOString() : undefined
        });
    }
}