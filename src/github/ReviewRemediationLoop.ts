import { GitHubService } from './GitHubService';
import { AgentRunner } from '../agents/AgentRunner';
import { AgentConfig } from '../types';

export class ReviewRemediationLoop {
    constructor(
        private githubService: GitHubService,
        private agentRunner: AgentRunner,
        private agentConfig: AgentConfig
    ) { }

    /**
     * Start the remediation loop for a given PR.
     * It will fetch review comments and attempt to feed them to the AgentRunner to resolve.
     */
    public async run(prNumber: number, maxRetries: number = 2): Promise<void> {
        let attempts = 0;

        while (attempts < maxRetries) {
            attempts++;

            // 1. Fetch Comments
            const comments = await this.githubService.getPRReviewComments(prNumber);
            const unresolvedComments = comments.filter((c: any) => !c.in_reply_to_id);

            if (unresolvedComments.length === 0) {
                console.log(`No open review comments found for PR #${prNumber}. Remediation complete.`);
                return;
            }

            console.log(`Found ${unresolvedComments.length} review comments. Starting remediation attempt ${attempts}/${maxRetries}...`);

            // 2. Synthesize prompt based on review comments
            const synthesizedPrompt = unresolvedComments.map((c: any) =>
                `Review feedback on file \`${c.path}\` at line ${c.original_line || c.line}:\n"${c.body}"\n\nPlease fix this issue.`
            ).join('\n\n---\n\n');

            // 3. Trigger Agent Execution (FR-057)
            console.log(`Checking out PR #${prNumber}...`);
            await this.githubService.pushToPR(prNumber); // Implicitly checks out

            await this.agentRunner.run(
                this.agentConfig.id,
                synthesizedPrompt,
                () => { }, // onText
                (thought: any) => { console.log(`[Remediation Thought]: ${thought.label}`); }, // onThought
                async (approvalRequest: any) => { return true; }, // onApproval
                async (diffParams: any) => { return true; }, // onDiff
                (usage: any) => { } // onTokenUsage
            );

            console.log(`Remediation attempt ${attempts} complete. Pushing fixes to PR #${prNumber}...`);
            await this.githubService.pushToPR(prNumber);

            // Next loop iteration will fetch comments again to see if they were resolved
        }
    }
}
