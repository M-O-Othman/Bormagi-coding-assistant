import { PolicyEngine } from './PolicyEngine';
import { ApprovalService } from './ApprovalService';

export type PromptApprovalCallback = (cmd: string, reason: string, rule?: string) => Promise<{ allow: boolean, scope: 'once' | 'task' | 'project' }>;

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
}

export class ExecWrapper {
    constructor(
        private policyEngine: PolicyEngine,
        private approvalService: ApprovalService,
        private promptUser: PromptApprovalCallback,
        private realExec: (cmd: string) => Promise<ExecResult>
    ) { }

    setPromptUser(promptUser: PromptApprovalCallback): void {
        this.promptUser = promptUser;
    }

    async guardedCommand(taskId: string, userId: string, isolationMode: string, command: string, reason: string): Promise<ExecResult> {
        const policy = await this.policyEngine.evaluate({
            taskId,
            repoId: 'local',
            isolationMode,
            userId,
            command,
            actionKind: 'exec_command'
        });

        if (policy.decision === 'deny') {
            throw new Error(`Blocked by sandbox policy: ${policy.reason}`);
        }

        if (policy.decision === 'ask' || policy.requiresApproval) {
            const isPreApproved = await this.approvalService.checkPreApproved(taskId, 'exec_command', command);
            if (!isPreApproved) {
                const approved = await this.promptUser(command, reason, policy.matchedRule);
                if (!approved.allow) {
                    throw new Error(`User denied command execution`);
                }
                await this.approvalService.recordApproval('exec_command', command, approved.scope, true);
            }
        }

        return this.realExec(command);
    }
}