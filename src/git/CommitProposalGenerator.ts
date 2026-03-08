import { GitService } from './GitService';

export interface CommitProposal {
    title: string;
    body?: string;
    conventionalType?: "feat" | "fix" | "docs" | "refactor" | "test" | "chore";
    scopes?: string[];
    linkedIssues?: string[];
    rationale: string[];
}

export class CommitProposalGenerator {
    constructor(private gitService: GitService) { }

    /** FR-032 / FR-033: Generate Diff-Grounded Commit Message */
    public async generate(repoRoot: string, taskSummary: string, style: "conventional" | "plain" = "conventional"): Promise<CommitProposal> {
        // 1. Get raw diff of staged/unstaged changes
        const diffText = await this.gitService.getDiff(repoRoot);
        const hasDiff = diffText.trim().length > 0;

        let type: CommitProposal['conventionalType'] = "chore";
        if (taskSummary.toLowerCase().includes('fix') || taskSummary.toLowerCase().includes('bug')) type = "fix";
        if (taskSummary.toLowerCase().includes('feat') || taskSummary.toLowerCase().includes('add')) type = "feat";
        if (taskSummary.toLowerCase().includes('doc')) type = "docs";

        const titleSlug = taskSummary.split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, "").trim();

        if (style === "conventional") {
            return {
                title: `${type}: ${titleSlug}`,
                body: hasDiff ? `- Automatically generated via AI Assistant\n- Diff size: ${diffText.split('\n').length} lines modified.` : 'Empty commit.',
                conventionalType: type,
                rationale: [taskSummary]
            };
        }

        return {
            title: titleSlug,
            body: hasDiff ? 'Assistant Edit applied.' : '',
            rationale: [taskSummary]
        };
    }
}
