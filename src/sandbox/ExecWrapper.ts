import { ExecResult, PolicyContext, ApprovalScope } from './types';
import { PolicyEngine } from './PolicyEngine';
import { ApprovalService } from './ApprovalService';

export type PromptApprovalCallback = (
    command: string,
    reason: string,
    ruleMatched?: string
) => Promise<{ allow: boolean; scope: ApprovalScope }>;

export type RawExecuteCallback = (command: string) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
}>;

export class ExecWrapper {
    constructor(
        private policyEngine: PolicyEngine,
        private approvalService: ApprovalService,
        private promptUser: PromptApprovalCallback,
        private rawExecute: RawExecuteCallback
    ) { }

    /** Replace the prompt callback (e.g. to route through inline chat cards instead of modal dialogs). */
    setPromptUser(fn: PromptApprovalCallback): void {
        this.promptUser = fn;
    }

    public async guardedCommand(
        taskId: string,
        userId: string,
        isolationMode: string,
        command: string,
        reason: string,
        secretsToRedact: string[] = []
    ): Promise<ExecResult> {

        const ctx: PolicyContext = {
            taskId,
            repoId: 'local',
            isolationMode,
            userId,
            command,
            actionKind: 'exec_command'
        };

        const policy = await this.policyEngine.evaluate(ctx);

        if (policy.decision === 'deny') {
            throw new Error(`Command blocked by policy: ${policy.reason} (Rule: ${policy.matchedRule})`);
        }

        let approvalMode: 'auto' | 'interactive' | 'policy' = 'policy';

        if (policy.decision === 'ask' || policy.requiresApproval) {
            // Check cache
            const hasPrior = this.approvalService.checkPriorApproval('exec_command', command, taskId);

            if (hasPrior) {
                approvalMode = 'auto';
            } else {
                approvalMode = 'interactive';
                const uiResponse = await this.promptUser(command, reason, policy.matchedRule);

                if (!uiResponse.allow) {
                    throw new Error(`Command execution denied by user: ${command}`);
                }

                // Record long-term if not just 'once'
                this.approvalService.recordApproval({
                    actionKind: 'exec_command',
                    matcher: command,
                    scope: uiResponse.scope,
                    allow: true,
                    reason: taskId // Lock to task if task-scoped
                });
            }
        }

        // Execute execution
        const rawRes = await this.rawExecute(command);

        return {
            command,
            exitCode: rawRes.exitCode,
            stdout: this.redactSecrets(rawRes.stdout, secretsToRedact),
            stderr: this.redactSecrets(rawRes.stderr, secretsToRedact),
            durationMs: rawRes.durationMs,
            approvalMode,
            policyRule: policy.matchedRule
        };
    }

    private redactSecrets(text: string, secrets: string[]): string {
        return secrets.reduce((acc, secret) => {
            if (!secret) return acc;
            return acc.split(secret).join('[REDACTED]');
        }, text);
    }
}
